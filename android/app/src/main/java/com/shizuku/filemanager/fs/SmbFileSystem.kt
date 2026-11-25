package com.shizuku.filemanager.fs

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import com.hierynomus.msdtyp.AccessMask
import com.hierynomus.msfscc.FileAttributes
import com.hierynomus.msfscc.fileinformation.FileStandardInformation
import com.hierynomus.mssmb2.SMB2CreateDisposition
import com.hierynomus.mssmb2.SMB2ShareAccess
import com.hierynomus.smbj.SMBClient
import com.hierynomus.smbj.auth.AuthenticationContext
import com.hierynomus.smbj.session.Session
import com.hierynomus.smbj.share.DiskShare
import com.shizuku.filemanager.model.FileItem
import com.shizuku.filemanager.model.SmbServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.InputStream
import java.io.OutputStream
import java.util.EnumSet

/**
 * SMB2/3 客户端文件系统（基于 SMBJ）
 * 支持枚举共享目录、浏览、下载、上传、复制、移动、删除、重命名与流式媒体播放。
 */
class SmbFileSystem(private val server: SmbServer, private val activeShare: String? = null) :
    UnifiedFileSystem {

    private val client = SMBClient()

    private fun <T> withSession(block: (Session) -> T): T {
        val conn = client.connect(server.host, server.port)
        return conn.use { c ->
            val auth = if (server.username.isBlank()) {
                AuthenticationContext.anonymous()
            } else {
                AuthenticationContext(server.username, server.password.toCharArray(), server.domain)
            }
            c.authenticate(auth).use(block)
        }
    }

    private fun resolveShareAndRelPath(path: String): Pair<String, String> {
        val clean = path.trimStart('/', '\\')
        if (!activeShare.isNullOrBlank()) {
            return activeShare to clean.replace('/', '\\')
        }
        val slash = clean.indexOf('/')
        return if (slash < 0) clean to "" else clean.substring(0, slash) to clean.substring(slash + 1).replace('/', '\\')
    }

    /** 枚举 SMB 服务器可用共享列表 */
    suspend fun listShares(): List<FileItem> = withContext(Dispatchers.IO) {
        if (server.share.isNotBlank()) {
            return@withContext listOf(
                FileItem(name = server.share, path = "/${server.share}", isDirectory = true)
            )
        }
        // 通过 IPC$ SRVSVC 或已知共享尝试返回列表；若权限受限返回友好提示
        withSession { session ->
            val names = mutableListOf<String>()
            runCatching {
                val share = session.connectShare("IPC$")
                share.close()
            }
            // 若用户未填固定共享名，枚举常见共享或由用户配置
            listOf("Users", "Public", "Share", "Media", "Downloads").forEach { candidate ->
                runCatching {
                    session.connectShare(candidate).use { names.add(candidate) }
                }
            }
            names.map { FileItem(name = it, path = "/$it", isDirectory = true) }
        }
    }

    override suspend fun list(dirPath: String, showHidden: Boolean): List<FileItem> =
        withContext(Dispatchers.IO) {
            if (dirPath.isBlank() || dirPath == "/") {
                if (activeShare.isNullOrBlank() && server.share.isBlank()) return@withContext listShares()
            }
            val (shareName, rel) = resolveShareAndRelPath(dirPath)
            withSession { session ->
                (session.connectShare(shareName) as DiskShare).use { share ->
                    share.list(rel).mapNotNull { info ->
                        val name = info.fileName
                        if (name == "." || name == "..") return@mapNotNull null
                        if (!showHidden && name.startsWith(".")) return@mapNotNull null
                        val isDir = (info.fileAttributes and FileAttributes.FILE_ATTRIBUTE_DIRECTORY.value) != 0L
                        val itemPath = if (rel.isEmpty()) "/$shareName/$name" else "/$shareName/${rel.replace('\\', '/')}/$name"
                        FileItem(
                            name = name,
                            path = itemPath,
                            isDirectory = isDir,
                            size = if (isDir) 0L else info.endOfFile,
                            modified = info.lastWriteTime.toEpochMillis()
                        )
                    }
                }
            }
        }

    override suspend fun mkdir(parentPath: String, name: String) = withContext(Dispatchers.IO) {
        val (shareName, rel) = resolveShareAndRelPath("$parentPath/$name")
        withSession { session ->
            (session.connectShare(shareName) as DiskShare).use { share ->
                share.mkdir(rel)
            }
        }
    }

    override suspend fun delete(path: String) = withContext(Dispatchers.IO) {
        val (shareName, rel) = resolveShareAndRelPath(path)
        withSession { session ->
            (session.connectShare(shareName) as DiskShare).use { share ->
                if (share.folderExists(rel)) share.rmdir(rel, true)
                else share.rm(rel)
            }
        }
    }

    override suspend fun rename(oldPath: String, newName: String): String = withContext(Dispatchers.IO) {
        val (shareName, oldRel) = resolveShareAndRelPath(oldPath)
        val parentRel = oldRel.substringBeforeLast('\\', "")
        val newRel = if (parentRel.isEmpty()) newName else "$parentRel\\$newName"
        withSession { session ->
            (session.connectShare(shareName) as DiskShare).use { share ->
                val isDir = share.folderExists(oldRel)
                val entry = if (isDir) {
                    share.openDirectory(
                        oldRel,
                        EnumSet.of(AccessMask.DELETE, AccessMask.GENERIC_WRITE),
                        null,
                        SMB2ShareAccess.ALL,
                        SMB2CreateDisposition.FILE_OPEN,
                        null
                    )
                } else {
                    share.openFile(
                        oldRel,
                        EnumSet.of(AccessMask.DELETE, AccessMask.GENERIC_WRITE),
                        null,
                        SMB2ShareAccess.ALL,
                        SMB2CreateDisposition.FILE_OPEN,
                        null
                    )
                }
                entry.use { it.rename(newRel, false) }
            }
        }
        "/$shareName/${newRel.replace('\\', '/')}"
    }

    override suspend fun copy(srcPath: String, destDir: String, onBytes: ((Long) -> Unit)?) =
        withContext(Dispatchers.IO) {
            val name = srcPath.trimEnd('/').substringAfterLast('/')
            val dstPath = "${destDir.trimEnd('/')}/$name"
            openInput(srcPath).use { input ->
                openOutput(dstPath).use { output ->
                    val buf = ByteArray(128 * 1024)
                    var n: Int
                    while (input.read(buf).also { n = it } != -1) {
                        output.write(buf, 0, n)
                        onBytes?.invoke(n.toLong())
                    }
                }
            }
        }

    override suspend fun move(srcPath: String, destDir: String, onBytes: ((Long) -> Unit)?) =
        withContext(Dispatchers.IO) {
            copy(srcPath, destDir, onBytes)
            delete(srcPath)
        }

    override suspend fun openInput(path: String): InputStream {
        val (shareName, rel) = resolveShareAndRelPath(path)
        val conn = client.connect(server.host, server.port)
        val auth = if (server.username.isBlank()) AuthenticationContext.anonymous()
        else AuthenticationContext(server.username, server.password.toCharArray(), server.domain)
        val session = conn.authenticate(auth)
        val share = session.connectShare(shareName) as DiskShare
        val file = share.openFile(
            rel,
            EnumSet.of(AccessMask.GENERIC_READ),
            null,
            SMB2ShareAccess.ALL,
            SMB2CreateDisposition.FILE_OPEN,
            null
        )
        val raw = file.inputStream
        return object : InputStream() {
            override fun read(): Int = raw.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int = raw.read(b, off, len)
            override fun close() {
                runCatching { raw.close() }
                runCatching { file.close() }
                runCatching { share.close() }
                runCatching { session.close() }
                runCatching { conn.close() }
            }
        }
    }

    override suspend fun openOutput(path: String): OutputStream {
        val (shareName, rel) = resolveShareAndRelPath(path)
        val conn = client.connect(server.host, server.port)
        val auth = if (server.username.isBlank()) AuthenticationContext.anonymous()
        else AuthenticationContext(server.username, server.password.toCharArray(), server.domain)
        val session = conn.authenticate(auth)
        val share = session.connectShare(shareName) as DiskShare
        val file = share.openFile(
            rel,
            EnumSet.of(AccessMask.GENERIC_WRITE, AccessMask.FILE_WRITE_DATA),
            null,
            SMB2ShareAccess.ALL,
            SMB2CreateDisposition.FILE_OVERWRITE_IF,
            null
        )
        val raw = file.outputStream
        return object : OutputStream() {
            override fun write(b: Int) = raw.write(b)
            override fun write(b: ByteArray, off: Int, len: Int) = raw.write(b, off, len)
            override fun close() {
                runCatching { raw.close() }
                runCatching { file.close() }
                runCatching { share.close() }
                runCatching { session.close() }
                runCatching { conn.close() }
            }
        }
    }
}

/**
 * ExoPlayer SMB 流式数据源（支持拖拽进度定位，不落盘即可播放 SMB 音视频）
 */
@UnstableApi
class SmbDataSource(
    private val server: SmbServer,
    private val shareName: String,
    private val relPath: String
) : BaseDataSource(true) {

    private var uri: Uri? = null
    private var smbClient: SMBClient? = null
    private var share: DiskShare? = null
    private var smbFile: com.hierynomus.smbj.share.File? = null
    private var position: Long = 0L
    private var bytesRemaining: Long = 0L

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)
        uri = dataSpec.uri
        val client = SMBClient().also { smbClient = it }
        val conn = client.connect(server.host, server.port)
        val auth = if (server.username.isBlank()) AuthenticationContext.anonymous()
        else AuthenticationContext(server.username, server.password.toCharArray(), server.domain)
        val session = conn.authenticate(auth)
        val diskShare = (session.connectShare(shareName) as DiskShare).also { share = it }
        val file = diskShare.openFile(
            relPath.replace('/', '\\'),
            EnumSet.of(AccessMask.GENERIC_READ),
            null,
            SMB2ShareAccess.ALL,
            SMB2CreateDisposition.FILE_OPEN,
            null
        ).also { smbFile = it }
        val totalSize = file.getFileInformation(FileStandardInformation::class.java).endOfFile
        position = dataSpec.position
        bytesRemaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
            dataSpec.length
        } else {
            (totalSize - position).coerceAtLeast(0L)
        }
        transferStarted(dataSpec)
        return bytesRemaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT
        val toRead = minOf(length.toLong(), bytesRemaining).toInt()
        val read = smbFile?.read(buffer, position, offset, toRead) ?: -1
        if (read <= 0) return C.RESULT_END_OF_INPUT
        position += read
        bytesRemaining -= read
        bytesTransferred(read)
        return read
    }

    override fun getUri(): Uri? = uri

    override fun close() {
        runCatching { smbFile?.close() }
        runCatching { share?.close() }
        runCatching { smbClient?.close() }
        smbFile = null
        share = null
        smbClient = null
        transferEnded()
    }

    class Factory(
        private val server: SmbServer,
        private val shareName: String,
        private val relPath: String
    ) : DataSource.Factory {
        override fun createDataSource(): DataSource = SmbDataSource(server, shareName, relPath)
    }
}
