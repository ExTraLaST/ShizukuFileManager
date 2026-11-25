package com.shizuku.filemanager

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.shizuku.filemanager.data.AppRepository
import com.shizuku.filemanager.data.MessageStore
import com.shizuku.filemanager.fs.*
import com.shizuku.filemanager.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream

/** 媒体预览打开请求 */
sealed class MediaOpenRequest {
    data class Image(val title: String, val path: String, val root: PaneRoot) : MediaOpenRequest()
    data class Video(val title: String, val path: String, val root: PaneRoot) : MediaOpenRequest()
}

/**
 * Shizuku 文件管理器安卓版核心 ViewModel
 */
class FileManagerViewModel(application: Application) : AndroidViewModel(application) {
    private val appCtx = application.applicationContext
    private val repo = AppRepository(appCtx)
    val messageStore = MessageStore(appCtx.filesDir)

    private val _settings = MutableStateFlow(repo.loadSettings())
    val settings: StateFlow<AppSettings> = _settings.asStateFlow()

    private val _bookmarks = MutableStateFlow(repo.loadBookmarks())
    val bookmarks: StateFlow<List<Bookmark>> = _bookmarks.asStateFlow()

    private val _smbServers = MutableStateFlow(repo.loadSmbServers())
    val smbServers: StateFlow<List<SmbServer>> = _smbServers.asStateFlow()

    private val _linkDevices = MutableStateFlow(repo.loadLinkDevices())
    val linkDevices: StateFlow<List<LinkServerConfig>> = _linkDevices.asStateFlow()

    private val _panes = MutableStateFlow(
        listOf(
            PaneState(id = "pane-0", tabs = listOf(TabState(title = "内部存储", path = "/storage/emulated/0"))),
            PaneState(id = "pane-1", tabs = listOf(TabState(title = "Download", path = "/storage/emulated/0/Download")))
        )
    )
    val panes: StateFlow<List<PaneState>> = _panes.asStateFlow()

    private val _activePaneIndex = MutableStateFlow(0)
    val activePaneIndex: StateFlow<Int> = _activePaneIndex.asStateFlow()

    private val _clipboard = MutableStateFlow<ClipboardData?>(null)
    val clipboard: StateFlow<ClipboardData?> = _clipboard.asStateFlow()

    private val _transfer = MutableStateFlow(TransferProgress())
    val transfer: StateFlow<TransferProgress> = _transfer.asStateFlow()

    private val _mediaRequest = MutableStateFlow<MediaOpenRequest?>(null)
    val mediaRequest: StateFlow<MediaOpenRequest?> = _mediaRequest.asStateFlow()

    private val _unreadCounts = MutableStateFlow(messageStore.unreadCounts())
    val unreadCounts: StateFlow<Map<String, Int>> = _unreadCounts.asStateFlow()

    private val _toast = MutableStateFlow<String?>(null)
    val toast: StateFlow<String?> = _toast.asStateFlow()

    private val localFs = LocalFileSystem { _settings.value.workMode }
    private var transferJob: Job? = null

    init {
        AudioPlaybackController.connect(appCtx)
        messageStore.prune(_settings.value.messageRetention)
        reloadPane(0)
        reloadPane(1)
        if (_settings.value.linkServerEnabled && _settings.value.linkServerPassword.isNotBlank()) {
            LinkServerService.start(appCtx)
        }
        viewModelScope.launch {
            LinkServerEvents.incomingMessages.collect {
                _unreadCounts.value = messageStore.unreadCounts()
                showToast("${it.from.ifBlank { "互联设备" }} 发来新消息")
            }
        }
    }

    fun showToast(msg: String) {
        _toast.value = msg
    }

    fun clearToast() {
        _toast.value = null
    }

    fun setActivePane(index: Int) {
        _activePaneIndex.value = index.coerceIn(0, 1)
    }

    /** 交换左右/上下双窗格 */
    fun swapPanes() {
        val cur = _panes.value
        if (cur.size >= 2) {
            _panes.value = listOf(cur[1].copy(id = "pane-0"), cur[0].copy(id = "pane-1"))
        }
    }

    // ---------------- 设置与主题 ----------------

    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        val next = transform(_settings.value)
        _settings.value = next
        repo.saveSettings(next)
        if (next.workMode == WorkMode.SHIZUKU) {
            if (!ShizukuBridge.hasPermission()) ShizukuBridge.requestPermission()
            else ShizukuBridge.bindIfReady()
        }
        if (next.linkServerEnabled && next.linkServerPassword.isNotBlank()) {
            LinkServerService.start(appCtx)
        } else {
            LinkServerService.stop(appCtx)
        }
        reloadPane(0)
        reloadPane(1)
    }

    // ---------------- 多标签页与导航 ----------------

    fun addTab(paneIdx: Int) {
        updatePane(paneIdx) { p ->
            val newTab = TabState(title = "内部存储", path = "/storage/emulated/0")
            p.copy(tabs = p.tabs + newTab, activeTabIndex = p.tabs.size)
        }
        reloadPane(paneIdx)
    }

    fun selectTab(paneIdx: Int, tabIdx: Int) {
        updatePane(paneIdx) { p -> p.copy(activeTabIndex = tabIdx.coerceIn(0, p.tabs.lastIndex)) }
        reloadPane(paneIdx)
    }

    fun closeTab(paneIdx: Int, tabIdx: Int) {
        updatePane(paneIdx) { p ->
            if (p.tabs.size <= 1) p
            else {
                val next = p.tabs.filterIndexed { i, _ -> i != tabIdx }
                p.copy(tabs = next, activeTabIndex = p.activeTabIndex.coerceAtMost(next.lastIndex))
            }
        }
        reloadPane(paneIdx)
    }

    fun navigate(paneIdx: Int, root: PaneRoot, path: String, title: String? = null) {
        updateActiveTab(paneIdx) { t ->
            t.copy(
                root = root,
                path = path,
                title = title ?: path.trimEnd('/').substringAfterLast('/').ifBlank {
                    when (root) {
                        PaneRoot.Local -> "根目录 /"
                        is PaneRoot.Smb -> root.server.name
                        is PaneRoot.Link -> root.device.name
                    }
                },
                selectedPaths = emptySet(),
                filterText = "",
                isSearchMode = false,
                searchQuery = ""
            )
        }
        reloadPane(paneIdx)
    }

    fun goUp(paneIdx: Int) {
        val tab = _panes.value[paneIdx].activeTab
        if (tab.isSearchMode) {
            updateActiveTab(paneIdx) { it.copy(isSearchMode = false, searchQuery = "") }
            reloadPane(paneIdx)
            return
        }
        when (val r = tab.root) {
            PaneRoot.Local -> {
                if (tab.path == "/" || tab.path.isBlank()) return
                val parent = File(tab.path).parent ?: "/"
                navigate(paneIdx, PaneRoot.Local, parent)
            }
            is PaneRoot.Smb -> {
                val clean = tab.path.trimEnd('/')
                val parent = clean.substringBeforeLast('/', "")
                navigate(paneIdx, r, if (parent.isBlank()) "/" else parent)
            }
            is PaneRoot.Link -> {
                val clean = tab.path.trimEnd('/')
                if (clean.isBlank() || clean == "/" || Regex("^[A-Za-z]:$").matches(clean)) {
                    navigate(paneIdx, r, "", r.device.name)
                } else {
                    val idx = clean.lastIndexOf('/')
                    val parent = when {
                        idx <= 0 -> if (clean.startsWith("/")) "/" else ""
                        Regex("^[A-Za-z]:$").matches(clean.substring(0, idx)) -> clean.substring(0, idx) + "/"
                        else -> clean.substring(0, idx)
                    }
                    navigate(paneIdx, r, parent)
                }
            }
        }
    }

    private fun fsFor(root: PaneRoot): UnifiedFileSystem = when (root) {
        PaneRoot.Local -> localFs
        is PaneRoot.Smb -> SmbFileSystem(root.server, root.share)
        is PaneRoot.Link -> LinkFileSystem(root.device)
    }

    fun reloadPane(paneIdx: Int) {
        val tab = _panes.value.getOrNull(paneIdx)?.activeTab ?: return
        viewModelScope.launch {
            updateActiveTab(paneIdx) { it.copy(loading = true, error = null) }
            try {
                val raw = if (tab.isSearchMode && tab.root == PaneRoot.Local && tab.searchQuery.isNotBlank()) {
                    localFs.searchRecursive(tab.path, tab.searchQuery)
                } else {
                    fsFor(tab.root).list(tab.path, _settings.value.showHiddenFiles)
                }
                val sorted = sortItems(raw, tab.sortField, tab.sortOrder)
                updateActiveTab(paneIdx) { it.copy(items = sorted, loading = false, error = null) }
            } catch (e: Exception) {
                updateActiveTab(paneIdx) { it.copy(loading = false, error = e.message ?: "加载失败") }
            }
        }
    }

    // ---------------- 排序、筛选、递归搜索、多选 ----------------

    fun setSort(paneIdx: Int, field: SortField, order: SortOrder) {
        updateActiveTab(paneIdx) { t ->
            t.copy(sortField = field, sortOrder = order, items = sortItems(t.items, field, order))
        }
    }

    fun setFilter(paneIdx: Int, text: String) {
        updateActiveTab(paneIdx) { it.copy(filterText = text) }
    }

    fun startLocalSearch(paneIdx: Int, query: String) {
        updateActiveTab(paneIdx) { it.copy(searchQuery = query, isSearchMode = query.isNotBlank()) }
        reloadPane(paneIdx)
    }

    fun toggleSelect(paneIdx: Int, path: String) {
        updateActiveTab(paneIdx) { t ->
            val next = if (t.selectedPaths.contains(path)) t.selectedPaths - path else t.selectedPaths + path
            t.copy(selectedPaths = next)
        }
    }

    fun selectAll(paneIdx: Int) {
        updateActiveTab(paneIdx) { t -> t.copy(selectedPaths = t.items.map { it.path }.toSet()) }
    }

    fun clearSelection(paneIdx: Int) {
        updateActiveTab(paneIdx) { it.copy(selectedPaths = emptySet()) }
    }

    // ---------------- 文件操作、打开方式与跨根传输 ----------------

    fun openItem(paneIdx: Int, item: FileItem) {
        val tab = _panes.value[paneIdx].activeTab
        if (item.isDirectory) {
            navigate(paneIdx, tab.root, item.path, item.name)
            return
        }
        when (item.kind) {
            FileKind.IMAGE -> _mediaRequest.value = MediaOpenRequest.Image(item.name, item.path, tab.root)
            FileKind.VIDEO -> _mediaRequest.value = MediaOpenRequest.Video(item.name, item.path, tab.root)
            FileKind.AUDIO -> playAudio(item, tab.root)
            else -> openWithSystem(item, tab.root)
        }
    }

    private fun playAudio(item: FileItem, root: PaneRoot) {
        when (root) {
            PaneRoot.Local -> AudioPlaybackController.playUri(appCtx, item.name, Uri.fromFile(File(item.path)))
            is PaneRoot.Link -> {
                val url = LinkClient(root.device).downloadUrl(item.path)
                AudioPlaybackController.playUri(appCtx, item.name, Uri.parse(url))
            }
            is PaneRoot.Smb -> {
                // 先缓存至临时目录再交由后台播放服务，确保后台/锁屏不中断
                viewModelScope.launch {
                    val tmp = File(appCtx.cacheDir, "smb_audio_${item.name}")
                    withContext(Dispatchers.IO) {
                        SmbFileSystem(root.server, root.share).openInput(item.path).use { ins ->
                            FileOutputStream(tmp).use { out -> ins.copyTo(out) }
                        }
                    }
                    AudioPlaybackController.playUri(appCtx, item.name, Uri.fromFile(tmp))
                }
            }
        }
    }

    fun closeMediaViewer() {
        _mediaRequest.value = null
    }

    /** 系统“打开方式” */
    fun openWithSystem(item: FileItem, root: PaneRoot) {
        viewModelScope.launch {
            try {
                val localFile = if (root == PaneRoot.Local) {
                    File(item.path)
                } else {
                    val tmp = File(appCtx.cacheDir, "open_${item.name}")
                    withContext(Dispatchers.IO) {
                        fsFor(root).openInput(item.path).use { ins ->
                            FileOutputStream(tmp).use { out -> ins.copyTo(out) }
                        }
                    }
                    tmp
                }
                val uri = FileProvider.getUriForFile(appCtx, "${BuildConfig.APPLICATION_ID}.fileprovider", localFile)
                val ext = localFile.extension.lowercase()
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, mime)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                appCtx.startActivity(Intent.createChooser(intent, "选择打开方式").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                showToast("无法打开：${e.message}")
            }
        }
    }

    fun createFolder(paneIdx: Int, name: String) {
        val tab = _panes.value[paneIdx].activeTab
        viewModelScope.launch {
            runCatching { fsFor(tab.root).mkdir(tab.path, name) }
                .onSuccess { reloadPane(paneIdx); showToast("已创建文件夹 $name") }
                .onFailure { showToast(it.message ?: "创建失败") }
        }
    }

    fun renameItem(paneIdx: Int, item: FileItem, newName: String) {
        val tab = _panes.value[paneIdx].activeTab
        viewModelScope.launch {
            runCatching { fsFor(tab.root).rename(item.path, newName) }
                .onSuccess { reloadPane(paneIdx); showToast("已重命名为 $newName") }
                .onFailure { showToast(it.message ?: "重命名失败") }
        }
    }

    fun deleteItems(paneIdx: Int, items: List<FileItem>) {
        val tab = _panes.value[paneIdx].activeTab
        viewModelScope.launch {
            runCatching {
                val fs = fsFor(tab.root)
                items.forEach { fs.delete(it.path) }
            }.onSuccess {
                clearSelection(paneIdx)
                reloadPane(paneIdx)
                showToast("已删除 ${items.size} 项")
            }.onFailure { showToast(it.message ?: "删除失败") }
        }
    }

    fun copyOrCut(paneIdx: Int, isCut: Boolean, items: List<FileItem>) {
        val tab = _panes.value[paneIdx].activeTab
        _clipboard.value = ClipboardData(isCut = isCut, sourceRoot = tab.root, items = items)
        clearSelection(paneIdx)
        showToast("已${if (isCut) "剪切" else "复制"} ${items.size} 项")
    }

    fun cancelTransfer() {
        transferJob?.cancel()
        _transfer.value = TransferProgress()
    }

    /** 粘贴（支持本机/SMB/互联任意跨源传输，带实时进度与速度） */
    fun pasteInto(paneIdx: Int) {
        val clip = _clipboard.value ?: return
        val dstTab = _panes.value[paneIdx].activeTab
        transferJob?.cancel()
        transferJob = viewModelScope.launch {
            val totalBytes = clip.items.sumOf { it.size }
            var doneBytes = 0L
            val startTime = System.currentTimeMillis()
            val updateProgress: (String, Int, Long) -> Unit = { name, doneCnt, delta ->
                doneBytes += delta
                val elapsed = ((System.currentTimeMillis() - startTime) / 1000.0).coerceAtLeast(0.1)
                _transfer.value = TransferProgress(
                    active = true,
                    title = if (clip.isCut) "正在移动" else "正在复制",
                    currentFile = name,
                    doneBytes = doneBytes,
                    totalBytes = totalBytes,
                    speedBytesPerSec = (doneBytes / elapsed).toLong(),
                    doneCount = doneCnt,
                    totalCount = clip.items.size
                )
            }
            try {
                val srcFs = fsFor(clip.sourceRoot)
                val dstFs = fsFor(dstTab.root)
                clip.items.forEachIndexed { idx, item ->
                    updateProgress(item.name, idx, 0)
                    if (clip.sourceRoot == dstTab.root) {
                        if (clip.isCut) srcFs.move(item.path, dstTab.path) { d -> updateProgress(item.name, idx, d) }
                        else srcFs.copy(item.path, dstTab.path) { d -> updateProgress(item.name, idx, d) }
                    } else {
                        transferCrossRoot(clip.sourceRoot, srcFs, item, dstTab.root, dstFs, dstTab.path) { d ->
                            updateProgress(item.name, idx, d)
                        }
                        if (clip.isCut) srcFs.delete(item.path)
                    }
                }
                if (clip.isCut) _clipboard.value = null
                showToast("传输完成")
                reloadPane(0)
                reloadPane(1)
            } catch (e: Exception) {
                showToast("传输失败：${e.message}")
            } finally {
                _transfer.value = TransferProgress()
            }
        }
    }

    private suspend fun transferCrossRoot(
        srcRoot: PaneRoot,
        srcFs: UnifiedFileSystem,
        item: FileItem,
        dstRoot: PaneRoot,
        dstFs: UnifiedFileSystem,
        dstDir: String,
        onBytes: (Long) -> Unit
    ) = withContext(Dispatchers.IO) {
        val dstPath = if (dstDir.endsWith("/")) "$dstDir${item.name}" else "$dstDir/${item.name}"
        if (item.isDirectory) {
            dstFs.mkdir(dstDir, item.name)
            srcFs.list(item.path, true).forEach { child ->
                transferCrossRoot(srcRoot, srcFs, child, dstRoot, dstFs, dstPath, onBytes)
            }
        } else if (srcRoot == PaneRoot.Local && dstRoot is PaneRoot.Link) {
            LinkClient(dstRoot.device).uploadFile(File(item.path), dstPath, onBytes)
        } else {
            srcFs.openInput(item.path).use { ins ->
                dstFs.openOutput(dstPath).use { out ->
                    val buf = ByteArray(128 * 1024)
                    var n: Int
                    while (ins.read(buf).also { n = it } != -1) {
                        out.write(buf, 0, n)
                        onBytes(n.toLong())
                    }
                }
            }
        }
    }

    // ---------------- 书签、SMB、互联设备、消息 ----------------

    fun addBookmark(name: String, path: String) {
        val next = _bookmarks.value + Bookmark(name = name, path = path)
        _bookmarks.value = next
        repo.saveBookmarks(next)
        showToast("已添加书签：$name")
    }

    fun removeBookmark(id: String) {
        val next = _bookmarks.value.filterNot { it.id == id }
        _bookmarks.value = next
        repo.saveBookmarks(next)
    }

    fun saveSmbServer(server: SmbServer) {
        val next = _smbServers.value.filterNot { it.id == server.id } + server
        _smbServers.value = next
        repo.saveSmbServers(next)
        showToast("已保存 SMB：${server.name}")
    }

    fun removeSmbServer(id: String) {
        val next = _smbServers.value.filterNot { it.id == id }
        _smbServers.value = next
        repo.saveSmbServers(next)
    }

    fun saveLinkDevice(dev: LinkServerConfig) {
        val next = _linkDevices.value.filterNot { it.id == dev.id } + dev
        _linkDevices.value = next
        repo.saveLinkDevices(next)
        showToast("已保存互联设备：${dev.name}")
    }

    fun removeLinkDevice(id: String) {
        val next = _linkDevices.value.filterNot { it.id == id }
        _linkDevices.value = next
        repo.saveLinkDevices(next)
    }

    fun sendChatMessage(device: LinkServerConfig, text: String, attachmentFile: File?) {
        viewModelScope.launch {
            try {
                val client = LinkClient(device)
                val s = _settings.value
                val att = if (attachmentFile != null && attachmentFile.isFile) {
                    val fid = client.uploadMessageFile(attachmentFile)
                    messageStore.copyIntoStore(device.id, fid, attachmentFile)
                    LinkAttachment(fid, attachmentFile.name, attachmentFile.length(), "application/octet-stream")
                } else null
                val now = System.currentTimeMillis()
                client.sendMessage(text, s.deviceName, s.deviceId, now, att)
                messageStore.add(
                    LinkMessage(
                        deviceId = device.id,
                        dir = "out",
                        text = text,
                        from = s.deviceName,
                        fromId = s.deviceId,
                        time = now,
                        attachment = att,
                        read = true
                    )
                )
            } catch (e: Exception) {
                showToast("发送失败：${e.message}")
            }
        }
    }

    fun markChatRead(deviceId: String) {
        messageStore.markRead(deviceId)
        _unreadCounts.value = messageStore.unreadCounts()
    }

    // ---------------- 内部工具 ----------------

    private fun updatePane(paneIdx: Int, block: (PaneState) -> PaneState) {
        val list = _panes.value.toMutableList()
        if (paneIdx in list.indices) {
            list[paneIdx] = block(list[paneIdx])
            _panes.value = list
        }
    }

    private fun updateActiveTab(paneIdx: Int, block: (TabState) -> TabState) {
        updatePane(paneIdx) { p ->
            val tabs = p.tabs.toMutableList()
            val idx = p.activeTabIndex.coerceIn(0, tabs.lastIndex)
            tabs[idx] = block(tabs[idx])
            p.copy(tabs = tabs)
        }
    }

    private fun sortItems(items: List<FileItem>, field: SortField, order: SortOrder): List<FileItem> {
        val cmp = Comparator<FileItem> { a, b ->
            if (a.isDirectory != b.isDirectory) return@Comparator if (a.isDirectory) -1 else 1
            val r = when (field) {
                SortField.NAME -> a.name.compareTo(b.name, ignoreCase = true)
                SortField.DATE -> a.modified.compareTo(b.modified)
                SortField.SIZE -> a.size.compareTo(b.size)
                SortField.TYPE -> a.kind.name.compareTo(b.kind.name)
            }
            if (order == SortOrder.ASC) r else -r
        }
        return items.sortedWith(cmp)
    }
}
