package com.shizuku.filemanager.data

import android.content.Context
import android.os.Build
import com.shizuku.filemanager.model.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * 设置、书签、SMB 服务器与互联设备持久化仓库
 */
class AppRepository(context: Context) {
    private val prefs = context.getSharedPreferences("shizuku_file_manager", Context.MODE_PRIVATE)

    fun loadSettings(): AppSettings {
        val existingId = prefs.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("deviceId", it).apply()
        }
        return AppSettings(
            deviceId = existingId,
            deviceName = prefs.getString("deviceName", Build.MODEL ?: "Android") ?: "Android",
            layoutMode = runCatching { LayoutMode.valueOf(prefs.getString("layoutMode", "SINGLE")!!) }
                .getOrDefault(LayoutMode.SINGLE),
            viewMode = runCatching { ViewMode.valueOf(prefs.getString("viewMode", "LIST")!!) }
                .getOrDefault(ViewMode.LIST),
            workMode = runCatching { WorkMode.valueOf(prefs.getString("workMode", "NORMAL")!!) }
                .getOrDefault(WorkMode.NORMAL),
            themeMode = runCatching { ThemeMode.valueOf(prefs.getString("themeMode", "SYSTEM")!!) }
                .getOrDefault(ThemeMode.SYSTEM),
            dynamicColor = prefs.getBoolean("dynamicColor", true),
            showHiddenFiles = prefs.getBoolean("showHiddenFiles", false),
            linkServerEnabled = prefs.getBoolean("linkServerEnabled", false),
            linkServerPort = prefs.getInt("linkServerPort", 8898),
            linkServerPassword = prefs.getString("linkServerPassword", "") ?: "",
            messageRetention = MessageRetention.fromKey(prefs.getString("messageRetention", "30d"))
        )
    }

    fun saveSettings(s: AppSettings) {
        prefs.edit()
            .putString("deviceId", s.deviceId)
            .putString("deviceName", s.deviceName)
            .putString("layoutMode", s.layoutMode.name)
            .putString("viewMode", s.viewMode.name)
            .putString("workMode", s.workMode.name)
            .putString("themeMode", s.themeMode.name)
            .putBoolean("dynamicColor", s.dynamicColor)
            .putBoolean("showHiddenFiles", s.showHiddenFiles)
            .putBoolean("linkServerEnabled", s.linkServerEnabled)
            .putInt("linkServerPort", s.linkServerPort)
            .putString("linkServerPassword", s.linkServerPassword)
            .putString("messageRetention", s.messageRetention.key)
            .apply()
    }

    // ---------------- 书签 ----------------
    fun loadBookmarks(): List<Bookmark> {
        val raw = prefs.getString("bookmarks", null)
        if (raw.isNullOrBlank()) {
            return listOf(
                Bookmark(name = "内部存储", path = "/storage/emulated/0"),
                Bookmark(name = "Download", path = "/storage/emulated/0/Download"),
                Bookmark(name = "DCIM 相册", path = "/storage/emulated/0/DCIM"),
                Bookmark(name = "根目录 /", path = "/")
            )
        }
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Bookmark(
                    id = o.optString("id", UUID.randomUUID().toString()),
                    name = o.getString("name"),
                    path = o.getString("path"),
                    rootType = o.optString("rootType", "local"),
                    serverId = o.optString("serverId").ifBlank { null }
                )
            }
        }.getOrDefault(emptyList())
    }

    fun saveBookmarks(list: List<Bookmark>) {
        val arr = JSONArray()
        list.forEach { b ->
            arr.put(JSONObject().apply {
                put("id", b.id)
                put("name", b.name)
                put("path", b.path)
                put("rootType", b.rootType)
                if (b.serverId != null) put("serverId", b.serverId)
            })
        }
        prefs.edit().putString("bookmarks", arr.toString()).apply()
    }

    // ---------------- SMB 服务器 ----------------
    fun loadSmbServers(): List<SmbServer> {
        val raw = prefs.getString("smbServers", null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                SmbServer(
                    id = o.optString("id", UUID.randomUUID().toString()),
                    name = o.getString("name"),
                    host = o.getString("host"),
                    port = o.optInt("port", 445),
                    username = o.optString("username", ""),
                    password = o.optString("password", ""),
                    domain = o.optString("domain", ""),
                    share = o.optString("share", "")
                )
            }
        }.getOrDefault(emptyList())
    }

    fun saveSmbServers(list: List<SmbServer>) {
        val arr = JSONArray()
        list.forEach { s ->
            arr.put(JSONObject().apply {
                put("id", s.id)
                put("name", s.name)
                put("host", s.host)
                put("port", s.port)
                put("username", s.username)
                put("password", s.password)
                put("domain", s.domain)
                put("share", s.share)
            })
        }
        prefs.edit().putString("smbServers", arr.toString()).apply()
    }

    // ---------------- 互联远程设备 ----------------
    fun loadLinkDevices(): List<LinkServerConfig> {
        val raw = prefs.getString("linkDevices", null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                LinkServerConfig(
                    id = o.optString("id", UUID.randomUUID().toString()),
                    name = o.getString("name"),
                    type = o.optString("type", "pc"),
                    host = o.getString("host"),
                    port = o.optInt("port", 8898),
                    password = o.optString("password", "")
                )
            }
        }.getOrDefault(emptyList())
    }

    fun saveLinkDevices(list: List<LinkServerConfig>) {
        val arr = JSONArray()
        list.forEach { d ->
            arr.put(JSONObject().apply {
                put("id", d.id)
                put("name", d.name)
                put("type", d.type)
                put("host", d.host)
                put("port", d.port)
                put("password", d.password)
            })
        }
        prefs.edit().putString("linkDevices", arr.toString()).apply()
    }
}

/**
 * 互联聊天消息与附件本地存储（对齐协议 v1：staging + 设备目录 + 保留期清理）
 */
class MessageStore(baseDir: File) {
    private val storeDir = File(baseDir, "messages")
    private val stagingDir = File(storeDir, "_staging")
    private val recordsFile = File(baseDir, "messages.json")
    private val lock = Any()
    private var cache: MutableList<LinkMessage>? = null

    private fun ensureLoaded(): MutableList<LinkMessage> {
        cache?.let { return it }
        val loaded = mutableListOf<LinkMessage>()
        if (recordsFile.exists()) {
            runCatching {
                val arr = JSONArray(recordsFile.readText(Charsets.UTF_8))
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    val attObj = o.optJSONObject("attachment")
                    val att = if (attObj != null) {
                        LinkAttachment(
                            fileId = attObj.getString("fileId"),
                            name = attObj.getString("name"),
                            size = attObj.optLong("size", 0L),
                            mime = attObj.optString("mime", "")
                        )
                    } else null
                    loaded.add(
                        LinkMessage(
                            id = o.optString("id", UUID.randomUUID().toString()),
                            deviceId = o.getString("deviceId"),
                            dir = o.optString("dir", "in"),
                            text = o.optString("text", ""),
                            from = o.optString("from", ""),
                            fromId = o.optString("fromId", ""),
                            time = o.optLong("time", System.currentTimeMillis()),
                            attachment = att,
                            read = o.optBoolean("read", true)
                        )
                    )
                }
            }
        }
        cache = loaded
        return loaded
    }

    private fun saveLocked() {
        val list = ensureLoaded()
        val arr = JSONArray()
        list.forEach { m ->
            arr.put(JSONObject().apply {
                put("id", m.id)
                put("deviceId", m.deviceId)
                put("dir", m.dir)
                put("text", m.text)
                put("from", m.from)
                put("fromId", m.fromId)
                put("time", m.time)
                put("read", m.read)
                if (m.attachment != null) {
                    put("attachment", JSONObject().apply {
                        put("fileId", m.attachment.fileId)
                        put("name", m.attachment.name)
                        put("size", m.attachment.size)
                        put("mime", m.attachment.mime)
                    })
                }
            })
        }
        recordsFile.parentFile?.mkdirs()
        recordsFile.writeText(arr.toString(), Charsets.UTF_8)
    }

    private fun deviceDir(deviceId: String): File {
        val safe = deviceId.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "unknown" }
        return File(storeDir, safe)
    }

    fun newFileId(): String = UUID.randomUUID().toString()

    fun stagingFile(fileId: String): File {
        stagingDir.mkdirs()
        return File(stagingDir, fileId)
    }

    fun stagingExists(fileId: String): Boolean = File(stagingDir, fileId).isFile

    fun removeStaging(fileId: String) {
        runCatching { File(stagingDir, fileId).delete() }
    }

    fun commitAttachment(fileId: String, deviceId: String) {
        val src = File(stagingDir, fileId)
        val dir = deviceDir(deviceId).apply { mkdirs() }
        val dst = File(dir, fileId)
        if (!src.renameTo(dst)) {
            src.copyTo(dst, overwrite = true)
            src.delete()
        }
    }

    fun copyIntoStore(deviceId: String, fileId: String, sourceFile: File) {
        val dir = deviceDir(deviceId).apply { mkdirs() }
        sourceFile.copyTo(File(dir, fileId), overwrite = true)
    }

    fun attachmentFile(deviceId: String, fileId: String): File = File(deviceDir(deviceId), fileId)

    fun add(msg: LinkMessage): LinkMessage = synchronized(lock) {
        val clean = msg.copy(text = msg.text.take(2000))
        ensureLoaded().add(clean)
        saveLocked()
        clean
    }

    fun list(deviceId: String): List<LinkMessage> = synchronized(lock) {
        ensureLoaded().filter { it.deviceId == deviceId }.sortedBy { it.time }
    }

    fun markRead(deviceId: String) = synchronized(lock) {
        var changed = false
        val list = ensureLoaded()
        for (i in list.indices) {
            if (list[i].deviceId == deviceId && list[i].dir == "in" && !list[i].read) {
                list[i] = list[i].copy(read = true)
                changed = true
            }
        }
        if (changed) saveLocked()
    }

    fun unreadCounts(): Map<String, Int> = synchronized(lock) {
        val map = mutableMapOf<String, Int>()
        ensureLoaded().forEach {
            if (it.dir == "in" && !it.read) map[it.deviceId] = (map[it.deviceId] ?: 0) + 1
        }
        map
    }

    fun prune(retention: MessageRetention, now: Long = System.currentTimeMillis()) = synchronized(lock) {
        val days = retention.days
        val list = ensureLoaded()
        if (days != null) {
            val cutoff = now - days * 24L * 3600L * 1000L
            val it = list.iterator()
            while (it.hasNext()) {
                val r = it.next()
                if (r.time < cutoff) {
                    r.attachment?.let { att -> runCatching { attachmentFile(r.deviceId, att.fileId).delete() } }
                    it.remove()
                }
            }
            saveLocked()
        }
        val refs = list.mapNotNull { r -> r.attachment?.let { "${r.deviceId}/${it.fileId}" } }.toSet()
        stagingDir.listFiles()?.forEach { f ->
            if (f.isFile && now - f.lastModified() > 3600_000L) runCatching { f.delete() }
        }
        storeDir.listFiles()?.forEach { dir ->
            if (dir.isDirectory && dir.name != "_staging") {
                dir.listFiles()?.forEach { f ->
                    if (!refs.contains("${dir.name}/${f.name}")) runCatching { f.delete() }
                }
            }
        }
    }

    fun openStagingStream(fileId: String): FileOutputStream = FileOutputStream(stagingFile(fileId))
}
