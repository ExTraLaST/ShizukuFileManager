package com.shizuku.filemanager.fs

import com.shizuku.filemanager.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.*
import java.nio.charset.StandardCharsets

const val LINK_PROTOCOL_VERSION = 1
const val LINK_DISCOVERY_PORT = 8897
const val LINK_DISCOVERY_REQUEST = "SHIZUKU-LINK-DISCOVER"
const val LINK_DISCOVERY_RESPONSE_PREFIX = "SHIZUKU-LINK-HERE "

data class DiscoveredLinkDevice(
    val name: String,
    val type: String,
    val host: String,
    val port: Int,
    val id: String?
)

data class LinkDeviceInfo(
    val name: String,
    val type: String,
    val version: Int,
    val id: String?
)

data class LinkRootInfo(
    val name: String,
    val path: String,
    val free: Long,
    val total: Long
)

data class QuickAccessEntry(
    val name: String,
    val path: String
)

/**
 * Shizuku 互联协议 v1 客户端（严格对齐 docs/PROTOCOL.md）
 */
class LinkClient(private val config: LinkServerConfig) {
    private val baseUrl = "http://${config.host}:${config.port}"

    private fun openConn(endpoint: String, method: String = "GET", readTimeoutMs: Int = 15000): HttpURLConnection {
        val conn = (URL(baseUrl + endpoint).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 5000
            readTimeout = readTimeoutMs
            setRequestProperty("X-Shizuku-Token", config.password)
        }
        return conn
    }

    private fun requestJson(endpoint: String, method: String = "GET", body: JSONObject? = null): JSONObject {
        val conn = openConn(endpoint, method)
        if (body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            val bytes = body.toString().toByteArray(StandardCharsets.UTF_8)
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }
        }
        val status = conn.responseCode
        val stream = if (status in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: "{}"
        conn.disconnect()
        val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
        if (status !in 200..299 || !json.optBoolean("ok", false)) {
            throw IllegalStateException(json.optString("error").ifBlank { "请求失败 (HTTP $status)" })
        }
        return json
    }

    private fun enc(v: String): String = URLEncoder.encode(v, "UTF-8")

    suspend fun info(): LinkDeviceInfo = withContext(Dispatchers.IO) {
        val j = requestJson("/api/info")
        val ver = j.optInt("version", 0)
        if (ver != LINK_PROTOCOL_VERSION) throw IllegalStateException("协议版本不兼容 ($ver)")
        LinkDeviceInfo(
            name = j.optString("name", config.host),
            type = j.optString("type", "pc"),
            version = ver,
            id = j.optString("id").ifBlank { null }
        )
    }

    suspend fun roots(): List<LinkRootInfo> = withContext(Dispatchers.IO) {
        val arr = requestJson("/api/roots").optJSONArray("roots") ?: return@withContext emptyList()
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            LinkRootInfo(
                name = o.optString("name"),
                path = o.optString("path"),
                free = o.optLong("free", 0L),
                total = o.optLong("total", 0L)
            )
        }
    }

    suspend fun quickAccess(): List<QuickAccessEntry> = withContext(Dispatchers.IO) {
        runCatching {
            val arr = requestJson("/api/quickaccess").optJSONArray("items") ?: return@withContext emptyList()
            (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                QuickAccessEntry(o.optString("name"), o.optString("path"))
            }
        }.getOrDefault(emptyList())
    }

    suspend fun list(wirePath: String): List<FileItem> = withContext(Dispatchers.IO) {
        val arr = requestJson("/api/list?path=${enc(wirePath)}").optJSONArray("items")
            ?: return@withContext emptyList()
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            FileItem(
                name = o.optString("name"),
                path = o.optString("path"),
                isDirectory = o.optBoolean("isDirectory", false),
                size = o.optLong("size", 0L),
                modified = o.optLong("modified", 0L)
            )
        }
    }

    suspend fun mkdir(wirePath: String) = withContext(Dispatchers.IO) {
        requestJson("/api/mkdir", "POST", JSONObject().put("path", wirePath))
    }

    suspend fun delete(wirePath: String) = withContext(Dispatchers.IO) {
        requestJson("/api/delete", "POST", JSONObject().put("path", wirePath))
    }

    suspend fun rename(wirePath: String, newName: String): String = withContext(Dispatchers.IO) {
        requestJson("/api/rename", "POST", JSONObject().put("path", wirePath).put("newName", newName))
            .optString("path")
    }

    suspend fun move(wirePath: String, destDir: String): String = withContext(Dispatchers.IO) {
        requestJson("/api/move", "POST", JSONObject().put("path", wirePath).put("destDir", destDir))
            .optString("path")
    }

    suspend fun copy(wirePath: String, destDir: String): String = withContext(Dispatchers.IO) {
        requestJson("/api/copy", "POST", JSONObject().put("path", wirePath).put("destDir", destDir))
            .optString("path")
    }

    suspend fun thumbnail(wirePath: String, size: Int = 256): ByteArray? = withContext(Dispatchers.IO) {
        runCatching {
            val conn = openConn("/api/thumbnail?path=${enc(wirePath)}&size=$size", "GET", 10000)
            try {
                if (conn.responseCode != 200) null
                else conn.inputStream.use { it.readBytes() }
            } finally {
                conn.disconnect()
            }
        }.getOrNull()
    }

    fun downloadUrl(wirePath: String): String = "$baseUrl/api/download?path=${enc(wirePath)}"
    fun authHeaders(): Map<String, String> = mapOf("X-Shizuku-Token" to config.password)

    fun openDownloadStream(wirePath: String): InputStream {
        val conn = openConn("/api/download?path=${enc(wirePath)}", "GET", 0)
        if (conn.responseCode !in 200..299) {
            conn.disconnect()
            throw IllegalStateException("下载失败 (HTTP ${conn.responseCode})")
        }
        val raw = conn.inputStream
        return object : InputStream() {
            override fun read(): Int = raw.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int = raw.read(b, off, len)
            override fun close() {
                runCatching { raw.close() }
                runCatching { conn.disconnect() }
            }
        }
    }

    suspend fun uploadFile(
        localFile: File,
        remotePath: String,
        onBytes: ((Long) -> Unit)? = null
    ) = withContext(Dispatchers.IO) {
        val conn = openConn("/api/upload?path=${enc(remotePath)}", "POST", 0).apply {
            doOutput = true
            setRequestProperty("Content-Type", "application/octet-stream")
            setFixedLengthStreamingMode(localFile.length())
        }
        try {
            localFile.inputStream().use { input ->
                conn.outputStream.use { output ->
                    val buf = ByteArray(128 * 1024)
                    var n: Int
                    while (input.read(buf).also { n = it } != -1) {
                        output.write(buf, 0, n)
                        onBytes?.invoke(n.toLong())
                    }
                }
            }
            if (conn.responseCode !in 200..299) {
                throw IllegalStateException("上传失败 (HTTP ${conn.responseCode})")
            }
        } finally {
            conn.disconnect()
        }
    }

    /** 阶段 1：上传消息附件到对端 staging */
    suspend fun uploadMessageFile(localFile: File, onBytes: ((Long) -> Unit)? = null): String =
        withContext(Dispatchers.IO) {
            val conn = openConn("/api/message-file?filename=${enc(localFile.name)}", "POST", 0).apply {
                doOutput = true
                setRequestProperty("Content-Type", "application/octet-stream")
                setFixedLengthStreamingMode(localFile.length())
            }
            try {
                localFile.inputStream().use { input ->
                    conn.outputStream.use { output ->
                        val buf = ByteArray(128 * 1024)
                        var n: Int
                        while (input.read(buf).also { n = it } != -1) {
                            output.write(buf, 0, n)
                            onBytes?.invoke(n.toLong())
                        }
                    }
                }
                val text = conn.inputStream.bufferedReader(StandardCharsets.UTF_8).use { it.readText() }
                val j = JSONObject(text)
                if (!j.optBoolean("ok", false)) throw IllegalStateException(j.optString("error", "附件上传失败"))
                j.getString("fileId")
            } finally {
                conn.disconnect()
            }
        }

    /** 阶段 2：发送文本/附件消息 */
    suspend fun sendMessage(
        text: String,
        from: String,
        fromId: String,
        time: Long,
        attachment: LinkAttachment?
    ) = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("text", text)
            put("from", from)
            put("fromId", fromId)
            put("time", time)
            if (attachment != null) {
                put("attachment", JSONObject().apply {
                    put("fileId", attachment.fileId)
                    put("name", attachment.name)
                    put("size", attachment.size)
                    put("mime", attachment.mime)
                })
            }
        }
        requestJson("/api/message", "POST", body)
    }
}

/**
 * 基于 LinkClient 的统一文件系统封装
 */
class LinkFileSystem(private val device: LinkServerConfig) : UnifiedFileSystem {
    val client = LinkClient(device)

    override suspend fun list(dirPath: String, showHidden: Boolean): List<FileItem> {
        if (dirPath.isBlank()) {
            val qa = client.quickAccess().map {
                FileItem(name = "★ ${it.name}", path = it.path, isDirectory = true)
            }
            val roots = client.roots().map {
                FileItem(name = it.name, path = it.path, isDirectory = true, size = it.total)
            }
            return qa + roots
        }
        return client.list(dirPath).filter { showHidden || !it.name.startsWith(".") }
    }

    override suspend fun mkdir(parentPath: String, name: String) {
        val joined = if (parentPath.endsWith("/")) "$parentPath$name" else "$parentPath/$name"
        client.mkdir(joined)
    }

    override suspend fun delete(path: String) = client.delete(path)
    override suspend fun rename(oldPath: String, newName: String): String = client.rename(oldPath, newName)
    override suspend fun copy(srcPath: String, destDir: String, onBytes: ((Long) -> Unit)?) {
        client.copy(srcPath, destDir)
    }
    override suspend fun move(srcPath: String, destDir: String, onBytes: ((Long) -> Unit)?) {
        client.move(srcPath, destDir)
    }
    override suspend fun openInput(path: String): InputStream = client.openDownloadStream(path)
    override suspend fun openOutput(path: String): OutputStream {
        // 缓冲后上传（大文件建议直接走 client.uploadFile）
        val baos = ByteArrayOutputStream()
        return object : OutputStream() {
            override fun write(b: Int) = baos.write(b)
            override fun write(b: ByteArray, off: Int, len: Int) = baos.write(b, off, len)
            override fun close() {
                val tmp = File.createTempFile("link-up-", ".bin")
                try {
                    tmp.writeBytes(baos.toByteArray())
                    kotlinx.coroutines.runBlocking { client.uploadFile(tmp, path) }
                } finally {
                    tmp.delete()
                }
            }
        }
    }
}

/**
 * UDP 8897 局域网自动发现客户端
 */
object LinkDiscovery {
    private fun localIps(): Set<String> {
        val out = mutableSetOf<String>()
        runCatching {
            val ifaces = NetworkInterface.getNetworkInterfaces()
            while (ifaces.hasMoreElements()) {
                val iface = ifaces.nextElement()
                val addrs = iface.inetAddresses
                while (addrs.hasMoreElements()) {
                    val a = addrs.nextElement()
                    if (a is Inet4Address) out.add(a.hostAddress ?: "")
                }
            }
        }
        return out
    }

    suspend fun scan(timeoutMs: Long = 2500L): List<DiscoveredLinkDevice> = withContext(Dispatchers.IO) {
        val found = linkedMapOf<String, DiscoveredLinkDevice>()
        val selfIps = localIps()
        val reqBytes = LINK_DISCOVERY_REQUEST.toByteArray(StandardCharsets.US_ASCII)
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = 300
            val targets = mutableSetOf(InetAddress.getByName("255.255.255.255"))
            runCatching {
                val ifaces = NetworkInterface.getNetworkInterfaces()
                while (ifaces.hasMoreElements()) {
                    val iface = ifaces.nextElement()
                    if (iface.isLoopback || !iface.isUp) continue
                    iface.interfaceAddresses.forEach { ia -> ia.broadcast?.let { targets.add(it) } }
                }
            }
            val start = System.currentTimeMillis()
            var rounds = 0
            val buf = ByteArray(2048)
            while (System.currentTimeMillis() - start < timeoutMs) {
                if (rounds < 3) {
                    targets.forEach { addr ->
                        runCatching {
                            socket.send(DatagramPacket(reqBytes, reqBytes.size, addr, LINK_DISCOVERY_PORT))
                        }
                    }
                    rounds++
                }
                runCatching {
                    val packet = DatagramPacket(buf, buf.size)
                    socket.receive(packet)
                    val ip = packet.address.hostAddress ?: return@runCatching
                    if (selfIps.contains(ip)) return@runCatching
                    val text = String(packet.data, 0, packet.length, StandardCharsets.UTF_8)
                    if (!text.startsWith(LINK_DISCOVERY_RESPONSE_PREFIX)) return@runCatching
                    val json = JSONObject(text.removePrefix(LINK_DISCOVERY_RESPONSE_PREFIX))
                    if (json.optInt("version") != LINK_PROTOCOL_VERSION) return@runCatching
                    val port = json.optInt("port", -1)
                    if (port !in 1..65535) return@runCatching
                    val key = "$ip:$port"
                    found.putIfAbsent(
                        key,
                        DiscoveredLinkDevice(
                            name = json.optString("name").ifBlank { ip },
                            type = if (json.optString("type") == "phone") "phone" else "pc",
                            host = ip,
                            port = port,
                            id = json.optString("id").ifBlank { null }
                        )
                    )
                }
            }
        }
        found.values.toList()
    }
}
