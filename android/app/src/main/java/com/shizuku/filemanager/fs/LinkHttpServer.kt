package com.shizuku.filemanager.fs

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.os.StatFs
import androidx.core.app.NotificationCompat
import com.shizuku.filemanager.data.AppRepository
import com.shizuku.filemanager.data.MessageStore
import com.shizuku.filemanager.model.Bookmark
import com.shizuku.filemanager.model.LinkAttachment
import com.shizuku.filemanager.model.LinkMessage
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.*
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.concurrent.Executors

/** 全局互联服务端状态与收信事件广播 */
object LinkServerEvents {
    val running = MutableStateFlow(false)
    val port = MutableStateFlow(8898)
    val incomingMessages = MutableSharedFlow<LinkMessage>(extraBufferCapacity = 32)
}

/**
 * 安卓端内置 Shizuku 互联 HTTP + UDP 服务端
 * 100% 实现 docs/PROTOCOL.md 全部 15 个 REST 接口，供电脑版或另一台手机访问本机。
 */
class LinkHttpServer(
    private val context: Context,
    private val port: Int,
    private val password: String,
    private val deviceName: String,
    private val deviceId: String,
    private val bookmarksProvider: () -> List<Bookmark>,
    private val messageStore: MessageStore,
    private val onMessageReceived: (LinkMessage) -> Unit
) {
    private val executor = Executors.newCachedThreadPool()
    @Volatile
    private var serverSocket: ServerSocket? = null
    @Volatile
    private var udpSocket: DatagramSocket? = null
    @Volatile
    private var active = false

    private val storageRoot: File = Environment.getExternalStorageDirectory()

    fun start() {
        if (password.isBlank()) error("密码为空，拒绝启动互联服务")
        if (active) return
        val ss = ServerSocket()
        ss.reuseAddress = true
        ss.bind(InetSocketAddress("0.0.0.0", port))
        serverSocket = ss
        active = true
        LinkServerEvents.running.value = true
        LinkServerEvents.port.value = ss.localPort

        executor.execute {
            while (active) {
                val client = runCatching { ss.accept() }.getOrNull() ?: break
                executor.execute { handleClient(client) }
            }
        }
        startUdpDiscovery(ss.localPort)
    }

    fun stop() {
        active = false
        LinkServerEvents.running.value = false
        runCatching { serverSocket?.close() }
        runCatching { udpSocket?.close() }
        serverSocket = null
        udpSocket = null
    }

    private fun startUdpDiscovery(actualPort: Int) {
        executor.execute {
            runCatching {
                val ds = DatagramSocket(null).apply {
                    reuseAddress = true
                    bind(InetSocketAddress("0.0.0.0", LINK_DISCOVERY_PORT))
                }
                udpSocket = ds
                val buf = ByteArray(512)
                while (active) {
                    val pkt = DatagramPacket(buf, buf.size)
                    ds.receive(pkt)
                    val req = String(pkt.data, 0, pkt.length, StandardCharsets.US_ASCII)
                    if (req != LINK_DISCOVERY_REQUEST) continue
                    val respJson = JSONObject().apply {
                        put("name", deviceName)
                        put("type", "phone")
                        put("port", actualPort)
                        put("version", LINK_PROTOCOL_VERSION)
                        put("id", deviceId)
                    }
                    val respBytes = (LINK_DISCOVERY_RESPONSE_PREFIX + respJson.toString())
                        .toByteArray(StandardCharsets.UTF_8)
                    ds.send(DatagramPacket(respBytes, respBytes.size, pkt.address, pkt.port))
                }
            }
        }
    }

    private fun checkToken(token: String?): Boolean {
        if (token == null) return false
        val sha = MessageDigest.getInstance("SHA-256")
        val a = sha.digest(token.toByteArray(StandardCharsets.UTF_8))
        val b = MessageDigest.getInstance("SHA-256").digest(password.toByteArray(StandardCharsets.UTF_8))
        return MessageDigest.isEqual(a, b)
    }

    private fun resolveSafeFile(rawPath: String?): File? {
        if (rawPath.isNullOrBlank() || rawPath.contains('\u0000') || rawPath.contains('\\')) return null
        if (rawPath.split('/').any { it == ".." }) return null
        val target = File(rawPath).canonicalFile
        val rootCanonical = storageRoot.canonicalFile
        return if (target.path == rootCanonical.path || target.path.startsWith(rootCanonical.path + "/")) target else null
    }

    private fun handleClient(socket: Socket) {
        socket.use { s ->
            s.soTimeout = 30000
            val input = BufferedInputStream(s.getInputStream())
            val output = BufferedOutputStream(s.getOutputStream())
            val reqLine = readHeaderLine(input) ?: return
            val parts = reqLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0].uppercase()
            val fullTarget = parts[1]
            val qIdx = fullTarget.indexOf('?')
            val pathname = if (qIdx >= 0) fullTarget.substring(0, qIdx) else fullTarget
            val query = parseQuery(if (qIdx >= 0) fullTarget.substring(qIdx + 1) else "")

            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = readHeaderLine(input) ?: break
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) {
                    headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
                }
            }

            if (!pathname.startsWith("/api/")) {
                sendJson(output, 404, JSONObject().put("ok", false).put("error", "接口不存在"))
                return
            }
            if (!checkToken(headers["x-shizuku-token"])) {
                sendJson(output, 401, JSONObject().put("ok", false).put("error", "密码错误"))
                return
            }

            try {
                when {
                    method == "GET" && pathname == "/api/info" -> {
                        sendJson(output, 200, JSONObject().apply {
                            put("ok", true)
                            put("name", deviceName)
                            put("type", "phone")
                            put("version", LINK_PROTOCOL_VERSION)
                            put("id", deviceId)
                        })
                    }
                    method == "GET" && pathname == "/api/roots" -> {
                        val stat = StatFs(storageRoot.path)
                        val arr = JSONArray().put(JSONObject().apply {
                            put("name", "内部存储")
                            put("path", storageRoot.absolutePath)
                            put("free", stat.availableBytes)
                            put("total", stat.totalBytes)
                        })
                        sendJson(output, 200, JSONObject().put("ok", true).put("roots", arr))
                    }
                    method == "GET" && pathname == "/api/quickaccess" -> {
                        val arr = JSONArray()
                        bookmarksProvider().filter { it.rootType == "local" }.forEach { b ->
                            val f = resolveSafeFile(b.path)
                            if (f != null && f.isDirectory) {
                                arr.put(JSONObject().put("name", b.name).put("path", f.absolutePath))
                            }
                        }
                        sendJson(output, 200, JSONObject().put("ok", true).put("items", arr))
                    }
                    method == "GET" && pathname == "/api/list" -> {
                        val dir = resolveSafeFile(query["path"])
                        if (dir == null) {
                            sendJson(output, 400, JSONObject().put("ok", false).put("error", "路径不合法"))
                        } else if (!dir.exists()) {
                            sendJson(output, 404, JSONObject().put("ok", false).put("error", "目录不存在"))
                        } else if (!dir.isDirectory) {
                            sendJson(output, 400, JSONObject().put("ok", false).put("error", "不是文件夹"))
                        } else {
                            val arr = JSONArray()
                            (dir.listFiles() ?: emptyArray()).forEach { f ->
                                arr.put(JSONObject().apply {
                                    put("name", f.name)
                                    put("path", f.absolutePath)
                                    put("isDirectory", f.isDirectory)
                                    put("size", if (f.isDirectory) 0L else f.length())
                                    put("modified", f.lastModified())
                                })
                            }
                            sendJson(output, 200, JSONObject().put("ok", true).put("items", arr))
                        }
                    }
                    method == "GET" && pathname == "/api/stat" -> {
                        val f = resolveSafeFile(query["path"])
                        if (f == null) {
                            sendJson(output, 400, JSONObject().put("ok", false).put("error", "路径不合法"))
                        } else if (!f.exists()) {
                            sendJson(output, 200, JSONObject().apply {
                                put("ok", true).put("exists", false).put("isDirectory", false)
                                    .put("size", 0).put("modified", 0)
                            })
                        } else {
                            sendJson(output, 200, JSONObject().apply {
                                put("ok", true).put("exists", true).put("isDirectory", f.isDirectory)
                                    .put("size", if (f.isDirectory) 0L else f.length())
                                    .put("modified", f.lastModified())
                            })
                        }
                    }
                    method == "GET" && pathname == "/api/download" -> {
                        handleDownload(output, query["path"], headers["range"])
                    }
                    method == "GET" && pathname == "/api/thumbnail" -> {
                        handleThumbnail(output, query["path"], query["size"]?.toIntOrNull() ?: 256)
                    }
                    method == "POST" && pathname == "/api/upload" -> {
                        handleUpload(input, output, query["path"], headers["content-length"]?.toLongOrNull() ?: -1L)
                    }
                    method == "POST" && pathname == "/api/mkdir" -> {
                        val body = readJsonBody(input, headers["content-length"]?.toIntOrNull() ?: 0)
                        val dir = resolveSafeFile(body.optString("path"))
                        if (dir == null) sendJson(output, 400, JSONObject().put("ok", false).put("error", "路径不合法"))
                        else {
                            dir.mkdirs()
                            sendJson(output, 200, JSONObject().put("ok", true))
                        }
                    }
                    method == "POST" && pathname == "/api/delete" -> {
                        val body = readJsonBody(input, headers["content-length"]?.toIntOrNull() ?: 0)
                        val f = resolveSafeFile(body.optString("path"))
                        if (f == null || f.canonicalPath == storageRoot.canonicalPath) {
                            sendJson(output, 400, JSONObject().put("ok", false).put("error", "路径不合法"))
                        } else if (!f.exists()) {
                            sendJson(output, 404, JSONObject().put("ok", false).put("error", "不存在"))
                        } else {
                            f.deleteRecursively()
                            sendJson(output, 200, JSONObject().put("ok", true))
                        }
                    }
                    method == "POST" && pathname == "/api/rename" -> {
                        val body = readJsonBody(input, headers["content-length"]?.toIntOrNull() ?: 0)
                        val f = resolveSafeFile(body.optString("path"))
                        val newName = body.optString("newName")
                        if (f == null || newName.isBlank() || newName.contains('/')) {
                            sendJson(output, 400, JSONObject().put("ok", false).put("error", "参数不合法"))
                        } else {
                            val dst = File(f.parentFile, newName)
                            if (dst.exists()) sendJson(output, 409, JSONObject().put("ok", false).put("error", "已存在同名文件"))
                            else {
                                f.renameTo(dst)
                                sendJson(output, 200, JSONObject().put("ok", true).put("path", dst.absolutePath))
                            }
                        }
                    }
                    method == "POST" && (pathname == "/api/move" || pathname == "/api/copy") -> {
                        val isMove = pathname == "/api/move"
                        val body = readJsonBody(input, headers["content-length"]?.toIntOrNull() ?: 0)
                        val src = resolveSafeFile(body.optString("path"))
                        val dstDir = resolveSafeFile(body.optString("destDir"))
                        if (src == null || dstDir == null || !src.exists() || !dstDir.isDirectory) {
                            sendJson(output, 400, JSONObject().put("ok", false).put("error", "路径不合法"))
                        } else {
                            var dst = File(dstDir, src.name)
                            var idx = 2
                            while (dst.exists()) {
                                val n = src.name
                                val dot = n.lastIndexOf('.')
                                val cand = if (!src.isDirectory && dot > 0) "${n.substring(0, dot)} ($idx)${n.substring(dot)}" else "$n ($idx)"
                                dst = File(dstDir, cand)
                                idx++
                            }
                            if (isMove) {
                                if (!src.renameTo(dst)) {
                                    src.copyRecursively(dst, overwrite = true)
                                    src.deleteRecursively()
                                }
                            } else {
                                src.copyRecursively(dst, overwrite = true)
                            }
                            sendJson(output, 200, JSONObject().put("ok", true).put("path", dst.absolutePath))
                        }
                    }
                    method == "POST" && pathname == "/api/message-file" -> {
                        val len = headers["content-length"]?.toLongOrNull() ?: -1L
                        if (len > 2L * 1024 * 1024 * 1024) {
                            sendJson(output, 413, JSONObject().put("ok", false).put("error", "附件过大"))
                        } else {
                            val fileId = messageStore.newFileId()
                            messageStore.openStagingStream(fileId).use { fos ->
                                copyExact(input, fos, len)
                            }
                            sendJson(output, 200, JSONObject().put("ok", true).put("fileId", fileId))
                        }
                    }
                    method == "POST" && pathname == "/api/message" -> {
                        val body = readJsonBody(input, headers["content-length"]?.toIntOrNull() ?: 0)
                        val text = body.optString("text", "")
                        val attJson = body.optJSONObject("attachment")
                        val att = if (attJson != null) {
                            val fid = attJson.optString("fileId")
                            if (!fid.matches(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")) || !messageStore.stagingExists(fid)) {
                                sendJson(output, 400, JSONObject().put("ok", false).put("error", "附件不存在"))
                                return
                            }
                            LinkAttachment(fid, attJson.optString("name", "file"), attJson.optLong("size", 0L), attJson.optString("mime", ""))
                        } else null
                        if (text.isEmpty() && att == null) {
                            sendJson(output, 400, JSONObject().put("ok", false).put("error", "消息为空"))
                            return
                        }
                        val peerId = body.optString("fromId").ifBlank { "unknown" }
                        if (att != null) messageStore.commitAttachment(att.fileId, peerId)
                        val record = messageStore.add(
                            LinkMessage(
                                deviceId = peerId,
                                dir = "in",
                                text = text,
                                from = body.optString("from", ""),
                                fromId = if (peerId == "unknown") "" else peerId,
                                time = body.optLong("time", System.currentTimeMillis()),
                                attachment = att,
                                read = false
                            )
                        )
                        onMessageReceived(record)
                        sendJson(output, 200, JSONObject().put("ok", true))
                    }
                    else -> sendJson(output, 404, JSONObject().put("ok", false).put("error", "接口不存在"))
                }
            } catch (e: Exception) {
                sendJson(output, 500, JSONObject().put("ok", false).put("error", e.message ?: "内部错误"))
            }
        }
    }

    private fun handleDownload(output: BufferedOutputStream, rawPath: String?, rangeHeader: String?) {
        val file = resolveSafeFile(rawPath)
        if (file == null || !file.exists() || file.isDirectory) {
            sendJson(output, 404, JSONObject().put("ok", false).put("error", "文件不存在"))
            return
        }
        val total = file.length()
        if (rangeHeader != null) {
            val range = parseRange(rangeHeader, total)
            if (range == null) {
                writeStatusAndHeaders(output, 416, "Range Not Satisfiable", mapOf(
                    "Content-Range" to "bytes */$total",
                    "Accept-Ranges" to "bytes",
                    "Content-Length" to "0"
                ))
                output.flush()
                return
            }
            val (start, end) = range
            val length = end - start + 1
            writeStatusAndHeaders(output, 206, "Partial Content", mapOf(
                "Content-Type" to "application/octet-stream",
                "Content-Length" to length.toString(),
                "Content-Range" to "bytes $start-$end/$total",
                "Accept-Ranges" to "bytes"
            ))
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(start)
                val buf = ByteArray(64 * 1024)
                var remain = length
                while (remain > 0) {
                    val n = raf.read(buf, 0, minOf(buf.size.toLong(), remain).toInt())
                    if (n <= 0) break
                    output.write(buf, 0, n)
                    remain -= n
                }
            }
            output.flush()
            return
        }
        writeStatusAndHeaders(output, 200, "OK", mapOf(
            "Content-Type" to "application/octet-stream",
            "Content-Length" to total.toString(),
            "Accept-Ranges" to "bytes"
        ))
        file.inputStream().use { it.copyTo(output, 64 * 1024) }
        output.flush()
    }

    private fun handleThumbnail(output: BufferedOutputStream, rawPath: String?, reqSize: Int) {
        val file = resolveSafeFile(rawPath)
        if (file == null || !file.isFile) {
            sendJson(output, 404, JSONObject().put("ok", false).put("error", "文件不存在"))
            return
        }
        val px = reqSize.coerceIn(128, 512)
        val bmp = ThumbnailLoader.loadLocalBitmapSync(context, file.absolutePath, px)
        if (bmp == null) {
            sendJson(output, 404, JSONObject().put("ok", false).put("error", "无法生成缩略图"))
            return
        }
        val baos = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 82, baos)
        val bytes = baos.toByteArray()
        writeStatusAndHeaders(output, 200, "OK", mapOf(
            "Content-Type" to "image/jpeg",
            "Content-Length" to bytes.size.toString(),
            "Cache-Control" to "private, max-age=86400"
        ))
        output.write(bytes)
        output.flush()
    }

    private fun handleUpload(
        input: BufferedInputStream,
        output: BufferedOutputStream,
        rawPath: String?,
        contentLength: Long
    ) {
        val target = resolveSafeFile(rawPath)
        if (target == null || target.isDirectory) {
            sendJson(output, 400, JSONObject().put("ok", false).put("error", "路径不合法"))
            return
        }
        target.parentFile?.mkdirs()
        val part = File(target.parentFile, ".${target.name}.shizuku-part-${System.currentTimeMillis()}")
        var written = 0L
        try {
            FileOutputStream(part).use { fos ->
                written = copyExact(input, fos, contentLength)
            }
            if (target.exists()) target.delete()
            if (!part.renameTo(target)) {
                part.copyTo(target, overwrite = true)
                part.delete()
            }
            sendJson(output, 200, JSONObject().put("ok", true).put("size", written))
        } catch (e: Exception) {
            runCatching { part.delete() }
            sendJson(output, 500, JSONObject().put("ok", false).put("error", e.message ?: "上传失败"))
        }
    }

    private fun parseRange(header: String, total: Long): Pair<Long, Long>? {
        val m = Regex("^bytes=(\\d*)-(\\d*)$").find(header.trim()) ?: return null
        val sStr = m.groupValues[1]
        val eStr = m.groupValues[2]
        if (total <= 0 || (sStr.isEmpty() && eStr.isEmpty())) return null
        return if (sStr.isEmpty()) {
            val suffix = eStr.toLongOrNull() ?: return null
            if (suffix <= 0) return null
            maxOf(0L, total - suffix) to (total - 1)
        } else {
            val start = sStr.toLongOrNull() ?: return null
            if (start < 0 || start >= total) return null
            val end = if (eStr.isEmpty()) total - 1 else (eStr.toLongOrNull() ?: return null).coerceAtMost(total - 1)
            if (end < start) return null
            start to end
        }
    }

    private fun copyExact(input: InputStream, output: OutputStream, length: Long): Long {
        val buf = ByteArray(64 * 1024)
        var total = 0L
        while (length < 0 || total < length) {
            val toRead = if (length < 0) buf.size else minOf(buf.size.toLong(), length - total).toInt()
            val n = input.read(buf, 0, toRead)
            if (n <= 0) break
            output.write(buf, 0, n)
            total += n
        }
        return total
    }

    private fun readJsonBody(input: BufferedInputStream, len: Int): JSONObject {
        if (len <= 0 || len > 1024 * 1024) return JSONObject()
        val bytes = ByteArray(len)
        var off = 0
        while (off < len) {
            val n = input.read(bytes, off, len - off)
            if (n <= 0) break
            off += n
        }
        return runCatching { JSONObject(String(bytes, 0, off, StandardCharsets.UTF_8)) }.getOrElse { JSONObject() }
    }

    private fun readHeaderLine(input: InputStream): String? {
        val baos = ByteArrayOutputStream()
        var prev = -1
        while (true) {
            val b = input.read()
            if (b == -1) return if (baos.size() == 0) null else baos.toString("UTF-8")
            if (b == '\n'.code) {
                val arr = baos.toByteArray()
                val end = if (prev == '\r'.code && arr.isNotEmpty()) arr.size - 1 else arr.size
                return String(arr, 0, end, StandardCharsets.UTF_8)
            }
            baos.write(b)
            prev = b
        }
    }

    private fun parseQuery(q: String): Map<String, String> {
        if (q.isEmpty()) return emptyMap()
        return q.split('&').mapNotNull { pair ->
            val eq = pair.indexOf('=')
            if (eq <= 0) null
            else URLDecoder.decode(pair.substring(0, eq), "UTF-8") to URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
        }.toMap()
    }

    private fun writeStatusAndHeaders(out: OutputStream, status: Int, reason: String, headers: Map<String, String>) {
        val sb = StringBuilder("HTTP/1.1 $status $reason\r\nConnection: close\r\n")
        headers.forEach { (k, v) -> sb.append("$k: $v\r\n") }
        sb.append("\r\n")
        out.write(sb.toString().toByteArray(StandardCharsets.US_ASCII))
    }

    private fun sendJson(out: OutputStream, status: Int, json: JSONObject) {
        val bytes = json.toString().toByteArray(StandardCharsets.UTF_8)
        writeStatusAndHeaders(out, status, if (status == 200) "OK" else "Error", mapOf(
            "Content-Type" to "application/json; charset=utf-8",
            "Content-Length" to bytes.size.toString()
        ))
        out.write(bytes)
        out.flush()
    }
}

/**
 * 互联服务端前台保活服务（支持系统消息通知与锁屏后台持续被电脑/手机访问）
 */
class LinkServerService : Service() {
    private var server: LinkHttpServer? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        val repo = AppRepository(this)
        val settings = repo.loadSettings()
        if (settings.linkServerPassword.isBlank()) {
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannels()
        startForeground(NOTIF_ID_SERVER, buildServerNotification(settings.linkServerPort))

        server?.stop()
        val msgStore = MessageStore(filesDir)
        server = LinkHttpServer(
            context = applicationContext,
            port = settings.linkServerPort,
            password = settings.linkServerPassword,
            deviceName = settings.deviceName,
            deviceId = settings.deviceId,
            bookmarksProvider = { repo.loadBookmarks() },
            messageStore = msgStore,
            onMessageReceived = { msg ->
                LinkServerEvents.incomingMessages.tryEmit(msg)
                notifyIncomingMessage(msg)
            }
        ).apply {
            runCatching { start() }.onFailure { stopSelf() }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        server?.stop()
        server = null
        super.onDestroy()
    }

    private fun ensureChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CH_SERVER, "Shizuku 互联服务", NotificationManager.IMPORTANCE_LOW)
            )
            nm.createNotificationChannel(
                NotificationChannel(CH_MESSAGE, "互联聊天消息", NotificationManager.IMPORTANCE_HIGH)
            )
        }
    }

    private fun buildServerNotification(port: Int): Notification =
        NotificationCompat.Builder(this, CH_SERVER)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle("Shizuku 互联服务运行中")
            .setContentText("端口 $port · 允许局域网设备访问本机与收发消息")
            .setOngoing(true)
            .build()

    private fun notifyIncomingMessage(msg: LinkMessage) {
        val nm = getSystemService(NotificationManager::class.java)
        val body = msg.text.ifBlank { msg.attachment?.let { "发来附件：${it.name}" } ?: "发来一条消息" }
        val notif = NotificationCompat.Builder(this, CH_MESSAGE)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setContentTitle("${msg.from.ifBlank { "互联设备" }} 发来消息")
            .setContentText(body)
            .setAutoCancel(true)
            .build()
        nm.notify(msg.id.hashCode(), notif)
    }

    companion object {
        const val ACTION_STOP = "com.shizuku.filemanager.STOP_LINK_SERVER"
        private const val CH_SERVER = "shizuku_link_server"
        private const val CH_MESSAGE = "shizuku_link_msg"
        private const val NOTIF_ID_SERVER = 2001

        fun start(context: Context) {
            val i = Intent(context, LinkServerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(i)
            else context.startService(i)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, LinkServerService::class.java).setAction(ACTION_STOP))
        }
    }
}
