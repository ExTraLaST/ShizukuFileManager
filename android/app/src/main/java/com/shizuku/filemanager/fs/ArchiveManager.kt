package com.shizuku.filemanager.fs

import com.github.junrar.Junrar
import com.shizuku.filemanager.model.ArchiveEntryItem
import com.shizuku.filemanager.model.ArchiveFormat
import com.shizuku.filemanager.model.CompressLevel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.lingala.zip4j.ZipFile
import net.lingala.zip4j.model.ZipParameters
import net.lingala.zip4j.model.enums.AesKeyStrength
import net.lingala.zip4j.model.enums.CompressionLevel
import net.lingala.zip4j.model.enums.EncryptionMethod
import org.apache.commons.compress.archivers.sevenz.SevenZFile
import org.apache.commons.compress.archivers.sevenz.SevenZOutputFile
import java.io.File
import java.io.FileOutputStream

/**
 * 安卓端压缩包管理器
 * 支持查看压缩包内部条目（zip / 7z / rar）、带密码解压以及 zip (AES-256) / 7z 压缩。
 */
object ArchiveManager {

    suspend fun listEntries(archiveFile: File, password: String? = null): List<ArchiveEntryItem> =
        withContext(Dispatchers.IO) {
            val ext = archiveFile.extension.lowercase()
            when (ext) {
                "zip" -> {
                    val zf = if (!password.isNullOrEmpty()) ZipFile(archiveFile, password.toCharArray()) else ZipFile(archiveFile)
                    zf.fileHeaders.map { h ->
                        val norm = h.fileName.replace('\\', '/').trimEnd('/')
                        ArchiveEntryItem(
                            path = norm,
                            name = norm.substringAfterLast('/'),
                            isDirectory = h.isDirectory,
                            size = h.uncompressedSize,
                            compressedSize = h.compressedSize,
                            modified = h.lastModifiedTimeEpoch,
                            encrypted = h.isEncrypted
                        )
                    }
                }
                "7z" -> {
                    val builder = SevenZFile.Builder().setFile(archiveFile)
                    if (!password.isNullOrEmpty()) builder.setPassword(password.toCharArray())
                    builder.get().use { sz ->
                        sz.entries.map { e ->
                            val norm = e.name.replace('\\', '/').trimEnd('/')
                            ArchiveEntryItem(
                                path = norm,
                                name = norm.substringAfterLast('/'),
                                isDirectory = e.isDirectory,
                                size = e.size,
                                compressedSize = 0L,
                                modified = if (e.hasLastModifiedDate) e.lastModifiedDate.time else 0L,
                                encrypted = !password.isNullOrEmpty()
                            )
                        }
                    }
                }
                "rar" -> {
                    com.github.junrar.Archive(archiveFile).use { rar ->
                        rar.fileHeaders.map { h ->
                            val norm = h.fileName.replace('\\', '/').trimEnd('/')
                            ArchiveEntryItem(
                                path = norm,
                                name = norm.substringAfterLast('/'),
                                isDirectory = h.isDirectory,
                                size = h.fullUnpackSize,
                                compressedSize = h.fullPackSize,
                                modified = h.mTime?.time ?: 0L,
                                encrypted = h.isEncrypted
                            )
                        }
                    }
                }
                else -> throw IllegalArgumentException("暂不支持查看 .$ext 格式压缩包")
            }
        }

    suspend fun extract(
        archiveFile: File,
        outDir: File,
        password: String? = null,
        onProgress: ((Int, String) -> Unit)? = null
    ) = withContext(Dispatchers.IO) {
        outDir.mkdirs()
        val ext = archiveFile.extension.lowercase()
        when (ext) {
            "zip" -> {
                val zf = if (!password.isNullOrEmpty()) ZipFile(archiveFile, password.toCharArray()) else ZipFile(archiveFile)
                val headers = zf.fileHeaders
                headers.forEachIndexed { idx, h ->
                    val target = File(outDir, h.fileName).canonicalFile
                    require(target.path.startsWith(outDir.canonicalPath)) { "检测到非法压缩包路径（Zip-Slip）" }
                    zf.extractFile(h, outDir.absolutePath)
                    onProgress?.invoke(((idx + 1) * 100) / maxOf(1, headers.size), h.fileName)
                }
            }
            "7z" -> {
                val builder = SevenZFile.Builder().setFile(archiveFile)
                if (!password.isNullOrEmpty()) builder.setPassword(password.toCharArray())
                builder.get().use { sz ->
                    val all = sz.entries.toList()
                    var count = 0
                    var entry = sz.nextEntry
                    val buf = ByteArray(64 * 1024)
                    while (entry != null) {
                        val outFile = File(outDir, entry.name).canonicalFile
                        require(outFile.path.startsWith(outDir.canonicalPath)) { "检测到非法路径" }
                        if (entry.isDirectory) {
                            outFile.mkdirs()
                        } else {
                            outFile.parentFile?.mkdirs()
                            FileOutputStream(outFile).use { fos ->
                                var n: Int
                                while (sz.read(buf).also { n = it } > 0) fos.write(buf, 0, n)
                            }
                        }
                        count++
                        onProgress?.invoke((count * 100) / maxOf(1, all.size), entry.name)
                        entry = sz.nextEntry
                    }
                }
            }
            "rar" -> {
                Junrar.extract(archiveFile, outDir)
                onProgress?.invoke(100, archiveFile.name)
            }
            else -> throw IllegalArgumentException("暂不支持解压 .$ext 格式")
        }
    }

    suspend fun compress(
        sources: List<File>,
        outFile: File,
        format: ArchiveFormat,
        level: CompressLevel,
        password: String? = null,
        onProgress: ((Int, String) -> Unit)? = null
    ) = withContext(Dispatchers.IO) {
        when (format) {
            ArchiveFormat.ZIP -> {
                val zf = if (!password.isNullOrEmpty()) ZipFile(outFile, password.toCharArray()) else ZipFile(outFile)
                val params = ZipParameters().apply {
                    compressionLevel = when (level) {
                        CompressLevel.FASTEST -> CompressionLevel.FASTEST
                        CompressLevel.FAST -> CompressionLevel.FAST
                        CompressLevel.NORMAL -> CompressionLevel.NORMAL
                        CompressLevel.MAXIMUM -> CompressionLevel.MAXIMUM
                        CompressLevel.ULTRA -> CompressionLevel.ULTRA
                    }
                    if (!password.isNullOrEmpty()) {
                        isEncryptFiles = true
                        encryptionMethod = EncryptionMethod.AES
                        aesKeyStrength = AesKeyStrength.KEY_STRENGTH_256
                    }
                }
                sources.forEachIndexed { idx, src ->
                    if (src.isDirectory) zf.addFolder(src, params) else zf.addFile(src, params)
                    onProgress?.invoke(((idx + 1) * 100) / maxOf(1, sources.size), src.name)
                }
            }
            ArchiveFormat.SEVEN_Z -> {
                SevenZOutputFile(outFile).use { szOut ->
                    fun addRec(file: File, base: String) {
                        val rel = if (base.isEmpty()) file.name else "$base/${file.name}"
                        val entry = szOut.createArchiveEntry(file, rel)
                        szOut.putArchiveEntry(entry)
                        if (file.isFile) {
                            file.inputStream().use { ins ->
                                val buf = ByteArray(64 * 1024)
                                var n: Int
                                while (ins.read(buf).also { n = it } > 0) szOut.write(buf, 0, n)
                            }
                        }
                        szOut.closeArchiveEntry()
                        if (file.isDirectory) {
                            file.listFiles()?.forEach { addRec(it, rel) }
                        }
                    }
                    sources.forEachIndexed { idx, src ->
                        addRec(src, "")
                        onProgress?.invoke(((idx + 1) * 100) / maxOf(1, sources.size), src.name)
                    }
                }
            }
        }
    }
}
