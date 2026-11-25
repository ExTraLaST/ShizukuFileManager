package com.shizuku.filemanager.ui

import android.graphics.Bitmap
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.shizuku.filemanager.FileManagerViewModel
import com.shizuku.filemanager.fs.ThumbnailLoader
import com.shizuku.filemanager.model.*
import java.io.File

/**
 * 安卓版主界面
 * 支持：单窗格 / 左右双窗格 / 上下双窗格、多标签页、交换窗格、侧滑抽屉（书签/SMB/互联）、
 * 排序筛选递归搜索、列表/图标视图、异步缩略图/视频帧/封面/APK 图标、迷你音乐播放条、传输速度浮条。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(vm: FileManagerViewModel) {
    val settings by vm.settings.collectAsState()
    val panes by vm.panes.collectAsState()
    val activePaneIdx by vm.activePaneIndex.collectAsState()
    val bookmarks by vm.bookmarks.collectAsState()
    val smbServers by vm.smbServers.collectAsState()
    val linkDevices by vm.linkDevices.collectAsState()
    val unreadCounts by vm.unreadCounts.collectAsState()
    val clipboard by vm.clipboard.collectAsState()
    val transfer by vm.transfer.collectAsState()
    val mediaRequest by vm.mediaRequest.collectAsState()
    val toast by vm.toast.collectAsState()

    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    var showSettings by remember { mutableStateOf(false) }
    var showSmbAdd by remember { mutableStateOf(false) }
    var showLinkMgr by remember { mutableStateOf(false) }
    var chatDevice by remember { mutableStateOf<LinkServerConfig?>(null) }
    var actionTarget by remember { mutableStateOf<Pair<Int, FileItem>?>(null) }
    var propsTarget by remember { mutableStateOf<FileItem?>(null) }
    var archiveViewFile by remember { mutableStateOf<File?>(null) }
    var compressReq by remember { mutableStateOf<Pair<File, List<File>>?>(null) }
    var renameTarget by remember { mutableStateOf<Pair<Int, FileItem>?>(null) }
    var showMkdir by remember { mutableStateOf(false) }

    LaunchedEffect(toast) {
        toast?.let {
            snackbarHostState.showSnackbar(it)
            vm.clearToast()
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            ModalDrawerSheet {
                Text("Shizuku 文件管理器", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(16.dp))
                HorizontalDivider()
                Text("快速访问与书签", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(12.dp, 8.dp))
                bookmarks.forEach { b ->
                    NavigationDrawerItem(
                        label = { Text(b.name) },
                        selected = false,
                        icon = { Icon(Icons.Default.Bookmark, null) },
                        onClick = {
                            vm.navigate(activePaneIdx, PaneRoot.Local, b.path, b.name)
                            scope.launch { drawerState.close() }
                        }
                    )
                }
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 12.dp)) {
                    Text("SMB 局域网共享", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                    IconButton(onClick = { showSmbAdd = true }) { Icon(Icons.Default.Add, "添加 SMB") }
                }
                smbServers.forEach { s ->
                    NavigationDrawerItem(
                        label = { Text(s.name) },
                        selected = false,
                        icon = { Icon(Icons.Default.Dns, null) },
                        onClick = {
                            val startPath = if (s.share.isNotBlank()) "/${s.share}" else "/"
                            vm.navigate(activePaneIdx, PaneRoot.Smb(s, s.share.ifBlank { null }), startPath, s.name)
                            scope.launch { drawerState.close() }
                        }
                    )
                }
                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 12.dp)) {
                    Text("互联设备", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                    IconButton(onClick = { showLinkMgr = true }) { Icon(Icons.Default.Wifi, "管理互联") }
                }
                linkDevices.forEach { d ->
                    val unread = unreadCounts[d.id] ?: 0
                    NavigationDrawerItem(
                        label = { Text(d.name) },
                        selected = false,
                        icon = { Icon(if (d.type == "phone") Icons.Default.Smartphone else Icons.Default.Computer, null) },
                        badge = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (unread > 0) Badge { Text("$unread") }
                                IconButton(onClick = { chatDevice = d }) { Icon(Icons.Default.Chat, "聊天") }
                            }
                        },
                        onClick = {
                            vm.navigate(activePaneIdx, PaneRoot.Link(d), "", d.name)
                            scope.launch { drawerState.close() }
                        }
                    )
                }
            }
        }
    ) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            topBar = {
                TopAppBar(
                    title = { Text("Shizuku 文件管理器", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }) {
                            Icon(Icons.Default.Menu, "菜单")
                        }
                    },
                    actions = {
                        IconButton(onClick = {
                            val next = when (settings.layoutMode) {
                                LayoutMode.SINGLE -> LayoutMode.DUAL_HORIZONTAL
                                LayoutMode.DUAL_HORIZONTAL -> LayoutMode.DUAL_VERTICAL
                                LayoutMode.DUAL_VERTICAL -> LayoutMode.SINGLE
                            }
                            vm.updateSettings { it.copy(layoutMode = next) }
                        }) {
                            Icon(
                                when (settings.layoutMode) {
                                    LayoutMode.SINGLE -> Icons.Default.CropSquare
                                    LayoutMode.DUAL_HORIZONTAL -> Icons.Default.ViewColumn
                                    LayoutMode.DUAL_VERTICAL -> Icons.Default.ViewAgenda
                                },
                                "切换单/双窗格"
                            )
                        }
                        if (settings.layoutMode != LayoutMode.SINGLE) {
                            IconButton(onClick = { vm.swapPanes() }) {
                                Icon(Icons.Default.SwapHoriz, "交换窗格")
                            }
                        }
                        IconButton(onClick = {
                            val nextView = if (settings.viewMode == ViewMode.LIST) ViewMode.GRID else ViewMode.LIST
                            vm.updateSettings { it.copy(viewMode = nextView) }
                        }) {
                            Icon(if (settings.viewMode == ViewMode.LIST) Icons.Default.GridView else Icons.Default.ViewList, "切换视图")
                        }
                        IconButton(onClick = { showMkdir = true }) { Icon(Icons.Default.CreateNewFolder, "新建文件夹") }
                        IconButton(onClick = { showLinkMgr = true }) { Icon(Icons.Default.Wifi, "互联") }
                        IconButton(onClick = { showSettings = true }) { Icon(Icons.Default.Settings, "设置") }
                    }
                )
            },
            bottomBar = {
                Column(Modifier.navigationBarsPadding()) {
                    // 传输进度与实时速度浮条
                    if (transfer.active) {
                        Surface(tonalElevation = 4.dp, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.padding(10.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(
                                        "${transfer.title}：${transfer.currentFile}",
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f)
                                    )
                                    Text("${formatFileSize(transfer.speedBytesPerSec)}/s", style = MaterialTheme.typography.labelMedium)
                                    TextButton(onClick = { vm.cancelTransfer() }) { Text("取消") }
                                }
                                LinearProgressIndicator(
                                    progress = {
                                        if (transfer.totalBytes > 0) (transfer.doneBytes.toFloat() / transfer.totalBytes).coerceIn(0f, 1f)
                                        else 0.5f
                                    },
                                    modifier = Modifier.fillMaxWidth()
                                )
                            }
                        }
                    }
                    // 剪贴板粘贴浮条
                    clipboard?.let { clip ->
                        Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
                            Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                Text("已${if (clip.isCut) "剪切" else "复制"} ${clip.items.size} 项", modifier = Modifier.weight(1f))
                                Button(onClick = { vm.pasteInto(activePaneIdx) }) { Text("粘贴到当前窗格") }
                            }
                        }
                    }
                    // 后台音乐迷你播放条
                    MiniAudioPlayerBar()
                }
            }
        ) { innerPadding ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding)
            ) {
                when (settings.layoutMode) {
                    LayoutMode.SINGLE -> PaneView(0, panes[0], activePaneIdx == 0, settings.viewMode, vm, onLongPress = { actionTarget = 0 to it }, modifier = Modifier.fillMaxSize())
                    LayoutMode.DUAL_HORIZONTAL -> Row(Modifier.fillMaxSize()) {
                        PaneView(0, panes[0], activePaneIdx == 0, settings.viewMode, vm, onLongPress = { actionTarget = 0 to it }, modifier = Modifier.weight(1f).fillMaxHeight())
                        VerticalDivider()
                        PaneView(1, panes[1], activePaneIdx == 1, settings.viewMode, vm, onLongPress = { actionTarget = 1 to it }, modifier = Modifier.weight(1f).fillMaxHeight())
                    }
                    LayoutMode.DUAL_VERTICAL -> Column(Modifier.fillMaxSize()) {
                        PaneView(0, panes[0], activePaneIdx == 0, settings.viewMode, vm, onLongPress = { actionTarget = 0 to it }, modifier = Modifier.weight(1f).fillMaxWidth())
                        HorizontalDivider()
                        PaneView(1, panes[1], activePaneIdx == 1, settings.viewMode, vm, onLongPress = { actionTarget = 1 to it }, modifier = Modifier.weight(1f).fillMaxWidth())
                    }
                }
            }
        }
    }

    // 各类弹窗
    mediaRequest?.let { MediaViewerOverlay(it, onClose = { vm.closeMediaViewer() }) }
    if (showSettings) SettingsDialog(vm, onDismiss = { showSettings = false })
    if (showSmbAdd) SmbAddDialog(onDismiss = { showSmbAdd = false }, onSave = { vm.saveSmbServer(it) })
    if (showLinkMgr) LinkManagerDialog(vm, onDismiss = { showLinkMgr = false }, onOpenChat = { chatDevice = it })
    chatDevice?.let { ChatDialog(vm, it, onDismiss = { chatDevice = null }) }
    propsTarget?.let { PropertiesDialog(it, onDismiss = { propsTarget = null }) }
    archiveViewFile?.let { f ->
        ArchiveViewerDialog(f, onDismiss = { archiveViewFile = null }, onExtracted = { vm.reloadPane(activePaneIdx) }, onToast = { vm.showToast(it) })
    }
    compressReq?.let { (dir, srcs) ->
        CompressDialog(srcs, dir, onDismiss = { compressReq = null }, onDone = { vm.reloadPane(activePaneIdx) }, onToast = { vm.showToast(it) })
    }
    actionTarget?.let { (pIdx, item) ->
        val tab = panes[pIdx].activeTab
        FileActionDialog(
            item = item,
            isLocal = tab.root == PaneRoot.Local,
            onDismiss = { actionTarget = null },
            onOpenWith = { vm.openWithSystem(item, tab.root) },
            onCopy = { vm.copyOrCut(pIdx, false, listOf(item)) },
            onCut = { vm.copyOrCut(pIdx, true, listOf(item)) },
            onRename = { renameTarget = pIdx to item },
            onDelete = { vm.deleteItems(pIdx, listOf(item)) },
            onProps = { propsTarget = item },
            onBookmark = { vm.addBookmark(item.name, item.path) },
            onViewArchive = { archiveViewFile = File(item.path) },
            onCompress = { compressReq = File(tab.path) to listOf(File(item.path)) }
        )
    }
    renameTarget?.let { (pIdx, item) ->
        var nextName by remember { mutableStateOf(item.name) }
        AlertDialog(
            onDismissRequest = { renameTarget = null },
            title = { Text("重命名") },
            text = { OutlinedTextField(value = nextName, onValueChange = { nextName = it }, singleLine = true) },
            confirmButton = {
                Button(onClick = { vm.renameItem(pIdx, item, nextName.trim()); renameTarget = null }) { Text("确定") }
            },
            dismissButton = { TextButton(onClick = { renameTarget = null }) { Text("取消") } }
        )
    }
    if (showMkdir) {
        var folderName by remember { mutableStateOf("新建文件夹") }
        AlertDialog(
            onDismissRequest = { showMkdir = false },
            title = { Text("新建文件夹") },
            text = { OutlinedTextField(value = folderName, onValueChange = { folderName = it }, singleLine = true) },
            confirmButton = {
                Button(onClick = { vm.createFolder(activePaneIdx, folderName.trim()); showMkdir = false }) { Text("创建") }
            },
            dismissButton = { TextButton(onClick = { showMkdir = false }) { Text("取消") } }
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PaneView(
    paneIdx: Int,
    pane: PaneState,
    isActive: Boolean,
    viewMode: ViewMode,
    vm: FileManagerViewModel,
    onLongPress: (FileItem) -> Unit,
    modifier: Modifier = Modifier
) {
    val tab = pane.activeTab
    val filtered = remember(tab.items, tab.filterText) {
        if (tab.filterText.isBlank()) tab.items
        else tab.items.filter { it.name.contains(tab.filterText, ignoreCase = true) }
    }

    Column(modifier = modifier) {
        // 多标签页栏
        ScrollableTabRow(selectedTabIndex = pane.activeTabIndex, edgePadding = 4.dp) {
            pane.tabs.forEachIndexed { idx, t ->
                Tab(
                    selected = idx == pane.activeTabIndex,
                    onClick = { vm.setActivePane(paneIdx); vm.selectTab(paneIdx, idx) },
                    text = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(t.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (pane.tabs.size > 1) {
                                IconButton(onClick = { vm.closeTab(paneIdx, idx) }, modifier = Modifier.size(20.dp)) {
                                    Icon(Icons.Default.Close, "关闭标签", modifier = Modifier.size(14.dp))
                                }
                            }
                        }
                    }
                )
            }
            Tab(selected = false, onClick = { vm.addTab(paneIdx) }, icon = { Icon(Icons.Default.Add, "新建标签") })
        }

        // 路径、筛选、排序与搜索工具行
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(if (isActive) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.25f) else MaterialTheme.colorScheme.surface)
                .padding(horizontal = 6.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = { vm.setActivePane(paneIdx); vm.goUp(paneIdx) }, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Default.ArrowUpward, "上级")
            }
            Text(
                text = tab.path.ifBlank { tab.title },
                style = MaterialTheme.typography.bodySmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            IconButton(
                onClick = {
                    val fields = SortField.entries
                    val nextField = fields[(fields.indexOf(tab.sortField) + 1) % fields.size]
                    vm.setSort(paneIdx, nextField, tab.sortOrder)
                },
                modifier = Modifier.size(32.dp)
            ) { Icon(Icons.Default.Sort, "排序") }
            IconButton(onClick = { vm.reloadPane(paneIdx) }, modifier = Modifier.size(32.dp)) {
                Icon(Icons.Default.Refresh, "刷新")
            }
        }

        // 筛选与递归搜索行
        var queryDraft by remember(tab.id) { mutableStateOf(tab.filterText) }
        Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(
                value = queryDraft,
                onValueChange = {
                    queryDraft = it
                    vm.setFilter(paneIdx, it)
                },
                placeholder = { Text("筛选或点击右侧递归搜索") },
                singleLine = true,
                modifier = Modifier.weight(1f)
            )
            if (tab.root == PaneRoot.Local) {
                IconButton(onClick = { vm.startLocalSearch(paneIdx, queryDraft) }) {
                    Icon(Icons.Default.Search, "本机递归搜索")
                }
            }
        }

        // 多选操作栏
        if (tab.selectedPaths.isNotEmpty()) {
            val selectedItems = filtered.filter { tab.selectedPaths.contains(it.path) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("已选 ${tab.selectedPaths.size}", modifier = Modifier.weight(1f))
                TextButton(onClick = { vm.copyOrCut(paneIdx, false, selectedItems) }) { Text("复制") }
                TextButton(onClick = { vm.copyOrCut(paneIdx, true, selectedItems) }) { Text("剪切") }
                TextButton(onClick = { vm.deleteItems(paneIdx, selectedItems) }) { Text("删除") }
                TextButton(onClick = { vm.clearSelection(paneIdx) }) { Text("取消") }
            }
        }

        // 内容列表或图标网格
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            when {
                tab.loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                tab.error != null -> Text(tab.error, color = MaterialTheme.colorScheme.error, modifier = Modifier.align(Alignment.Center).padding(16.dp))
                viewMode == ViewMode.LIST -> LazyColumn(Modifier.fillMaxSize()) {
                    items(filtered, key = { it.path }) { item ->
                        val isSel = tab.selectedPaths.contains(item.path)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(if (isSel) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface)
                                .combinedClickable(
                                    onClick = {
                                        vm.setActivePane(paneIdx)
                                        if (tab.selectedPaths.isNotEmpty()) vm.toggleSelect(paneIdx, item.path)
                                        else vm.openItem(paneIdx, item)
                                    },
                                    onLongClick = { vm.setActivePane(paneIdx); onLongPress(item) }
                                )
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            FileThumbIcon(item, tab.root, 40)
                            Spacer(Modifier.width(12.dp))
                            Column(Modifier.weight(1f)) {
                                Text(item.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Text(
                                    if (item.isDirectory) "文件夹" else "${formatFileSize(item.size)} · ${formatTime(item.modified)}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Checkbox(checked = isSel, onCheckedChange = { vm.toggleSelect(paneIdx, item.path) })
                        }
                    }
                }
                else -> LazyVerticalGrid(columns = GridCells.Adaptive(100.dp), modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(6.dp)) {
                    items(filtered, key = { it.path }) { item ->
                        val isSel = tab.selectedPaths.contains(item.path)
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier
                                .padding(4.dp)
                                .background(if (isSel) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface, MaterialTheme.shapes.medium)
                                .combinedClickable(
                                    onClick = {
                                        vm.setActivePane(paneIdx)
                                        if (tab.selectedPaths.isNotEmpty()) vm.toggleSelect(paneIdx, item.path)
                                        else vm.openItem(paneIdx, item)
                                    },
                                    onLongClick = { vm.setActivePane(paneIdx); onLongPress(item) }
                                )
                                .padding(8.dp)
                        ) {
                            FileThumbIcon(item, tab.root, 56)
                            Spacer(Modifier.height(4.dp))
                            Text(item.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
        }
    }
}

/** 异步缩略图（图片 / 视频预览帧 / 音乐封面 / APK 图标 / 远程互联缩略图） */
@Composable
private fun FileThumbIcon(item: FileItem, root: PaneRoot, sizeDp: Int) {
    val context = LocalContext.current
    var bmp by remember(item.path) { mutableStateOf<Bitmap?>(null) }

    LaunchedEffect(item.path, root) {
        if (!item.isDirectory) {
            bmp = when (root) {
                PaneRoot.Local -> if (item.kind in setOf(FileKind.IMAGE, FileKind.VIDEO, FileKind.AUDIO, FileKind.APK)) {
                    ThumbnailLoader.loadLocal(context, item.path, sizeDp * 3)
                } else null
                is PaneRoot.Link -> if (item.kind in setOf(FileKind.IMAGE, FileKind.VIDEO)) {
                    ThumbnailLoader.loadRemote(root.device, item.path, 256)
                } else null
                is PaneRoot.Smb -> null
            }
        }
    }

    val loaded = bmp
    if (loaded != null) {
        Image(bitmap = loaded.asImageBitmap(), contentDescription = null, modifier = Modifier.size(sizeDp.dp))
    } else {
        val icon = when (item.kind) {
            FileKind.FOLDER -> Icons.Default.Folder
            FileKind.IMAGE -> Icons.Default.Image
            FileKind.VIDEO -> Icons.Default.Movie
            FileKind.AUDIO -> Icons.Default.MusicNote
            FileKind.ARCHIVE -> Icons.Default.FolderZip
            FileKind.APK -> Icons.Default.Android
            FileKind.DOCUMENT -> Icons.Default.Description
            FileKind.OTHER -> Icons.Default.InsertDriveFile
        }
        Icon(icon, contentDescription = null, modifier = Modifier.size(sizeDp.dp), tint = MaterialTheme.colorScheme.primary)
    }
}
