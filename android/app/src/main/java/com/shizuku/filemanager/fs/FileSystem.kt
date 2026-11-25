package com.shizuku.filemanager.fs

import com.shizuku.filemanager.model.FileItem
import com.shizuku.filemanager.model.WorkMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream

/**
 * 安卓端统一文件系统接口（Local / Root / Shizuku / SMB / Link 统一实现）
 */
interface UnifiedFileSystem {
    suspend fun list(dirPath: String, showHidden: Boolean = false): List<FileItem>
    suspend fun mkdir(parentPath: String, name: String)
    suspend fun delete(path: String)
    suspend fun rename(oldPath: String, newName: String): String
    suspend fun copy(srcPath: String, destDir: String, onBytes: ((Long) -> Unit)? = null)
    suspend fun move(srcPath: String, destDir: String, onBytes: ((Long) -> Unit)? = null)
    suspend fun openInput(path: String): InputStream
    suspend fun openOutput(path: String): OutputStream
}

/**
 * 本机文件系统（自动根据 WorkMode 切换标准 File API / Shizuku UserService / Root Shell）
 */
class LocalFileSystem(private val workModeProvider: () -> WorkMode) : UnifiedFileSystem {

    private fun needsPrivileged(path: String): Boolean {
        val mode = workModeProvider()
        if (mode == WorkMode.NORMAL) return false
        val f = File(path)
        if (!f.exists() || !f.canRead()) return true
        return path.startsWith("/data") ||
            path.startsWith("/system") ||
            path.contains("/Android/data") ||
            path.contains("/Android/obb")
    }

    private fun execPriv(cmd: String): String {
        return when (workModeProvider()) {
            WorkMode.SHIZUKU -> ShizukuBridge.exec(cmd) ?: throw IllegalStateException("Shizuku 服务未就绪")
            WorkMode.ROOT -> RootShell.exec(cmd)
            WorkMode.NORMAL -> throw SecurityException("需要开启 Root 或 Shizuku 模式")
        }
    }

    private fun execPrivCode(cmd: String): Int {
        return when (workModeProvider()) {
            WorkMode.SHIZUKU -> ShizukuBridge.execCode(cmd)
            WorkMode.ROOT -> RootShell.execCode(cmd)
            WorkMode.NORMAL -> -1
        }
    }

    override suspend fun list(dirPath: String, showHidden: Boolean): List<FileItem> =
        withContext(Dispatchers.IO) {
            val dir = File(dirPath)
            val direct = dir.listFiles()
            if (direct != null) {
                return@withContext direct
                    .filter { showHidden || !it.name.startsWith(".") }
                    .map { f ->
                        FileItem(
                            name = f.name,
                            path = f.absolutePath,
                            isDirectory = f.isDirectory,
                            size = if (f.isDirectory) 0L else f.length(),
                            modified = f.lastModified()
                        )
                    }
            }
            if (workModeProvider() != WorkMode.NORMAL) {
                val out = execPriv("ls -la ${ShellParser.quote(dirPath)}")
                return@withContext ShellParser.parseLsOutput(dirPath, out, showHidden)
            }
            throw SecurityException("无权访问目录：$dirPath（请授予存储权限或开启 Shizuku/Root 模式）")
        }

    override suspend fun mkdir(parentPath: String, name: String) = withContext(Dispatchers.IO) {
        val target = File(parentPath, name)
        if (target.mkdirs()) return@withContext
        if (workModeProvider() != WorkMode.NORMAL) {
            if (execPrivCode("mkdir -p ${ShellParser.quote(target.absolutePath)}") == 0) return@withContext
        }
        throw IllegalStateException("创建文件夹失败：${target.absolutePath}")
    }

    override suspend fun delete(path: String) = withContext(Dispatchers.IO) {
        val f = File(path)
        if (f.exists() && f.deleteRecursively()) return@withContext
        if (workModeProvider() != WorkMode.NORMAL) {
            if (execPrivCode("rm -rf ${ShellParser.quote(path)}") == 0) return@withContext
        }
        throw IllegalStateException("删除失败：$path")
    }

    override suspend fun rename(oldPath: String, newName: String): String = withContext(Dispatchers.IO) {
        val oldFile = File(oldPath)
        val newFile = File(oldFile.parentFile ?: File("/"), newName)
        if (oldFile.renameTo(newFile)) return@withContext newFile.absolutePath
        if (workModeProvider() != WorkMode.NORMAL) {
            if (execPrivCode("mv ${ShellParser.quote(oldPath)} ${ShellParser.quote(newFile.absolutePath)}") == 0) {
                return@withContext newFile.absolutePath
            }
        }
        throw IllegalStateException("重命名失败：$oldPath")
    }

    override suspend fun copy(srcPath: String, destDir: String, onBytes: ((Long) -> Unit)?) =
        withContext(Dispatchers.IO) {
            val src = File(srcPath)
            val dst = uniqueTarget(File(destDir), src.name, src.isDirectory)
            if (needsPrivileged(srcPath) || needsPrivileged(destDir)) {
                if (execPrivCode("cp -r ${ShellParser.quote(srcPath)} ${ShellParser.quote(dst.absolutePath)}") == 0) {
                    return@withContext
                }
            }
            copyRecursive(src, dst, onBytes)
        }

    override suspend fun move(srcPath: String, destDir: String, onBytes: ((Long) -> Unit)?) =
        withContext(Dispatchers.IO) {
            val src = File(srcPath)
            val dst = uniqueTarget(File(destDir), src.name, src.isDirectory)
            if (src.renameTo(dst)) return@withContext
            if (needsPrivileged(srcPath) || needsPrivileged(destDir)) {
                if (execPrivCode("mv ${ShellParser.quote(srcPath)} ${ShellParser.quote(dst.absolutePath)}") == 0) {
                    return@withContext
                }
            }
            copyRecursive(src, dst, onBytes)
            src.deleteRecursively()
        }

    override suspend fun openInput(path: String): InputStream = FileInputStream(File(path))
    override suspend fun openOutput(path: String): OutputStream {
        val f = File(path)
        f.parentFile?.mkdirs()
        return FileOutputStream(f)
    }

    /** 本机递归搜索（迭代式防栈溢出、支持协程取消） */
    suspend fun searchRecursive(
        rootDir: String,
        query: String,
        maxResults: Int = 500
    ): List<FileItem> = withContext(Dispatchers.IO) {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return@withContext emptyList()
        val results = mutableListOf<FileItem>()
        val stack = ArrayDeque<File>()
        stack.add(File(rootDir))
        while (stack.isNotEmpty() && isActive && results.size < maxResults) {
            val cur = stack.removeLast()
            val children = cur.listFiles() ?: continue
            for (child in children) {
                if (!isActive || results.size >= maxResults) break
                if (child.name.lowercase().contains(q)) {
                    results.add(
                        FileItem(
                            name = child.name,
                            path = child.absolutePath,
                            isDirectory = child.isDirectory,
                            size = if (child.isDirectory) 0L else child.length(),
                            modified = child.lastModified()
                        )
                    )
                }
                if (child.isDirectory && !child.name.startsWith(".")) {
                    stack.add(child)
                }
            }
        }
        results
    }

    private fun uniqueTarget(dir: File, name: String, isDir: Boolean): File {
        var candidate = File(dir, name)
        var n = 2
        while (candidate.exists()) {
            val next = if (isDir) "$name ($n)" else {
                val dot = name.lastIndexOf('.')
                if (dot > 0) "${name.substring(0, dot)} ($n)${name.substring(dot)}" else "$name ($n)"
            }
            candidate = File(dir, next)
            n++
        }
        return candidate
    }

    private fun copyRecursive(src: File, dst: File, onBytes: ((Long) -> Unit)?) {
        if (src.isDirectory) {
            dst.mkdirs()
            src.listFiles()?.forEach { child ->
                copyRecursive(child, File(dst, child.name), onBytes)
            }
        } else {
            dst.parentFile?.mkdirs()
            FileInputStream(src).use { input ->
                FileOutputStream(dst).use { output ->
                    val buf = ByteArray(128 * 1024)
                    var read: Int
                    while (input.read(buf).also { read = it } != -1) {
                        output.write(buf, 0, read)
                        onBytes?.invoke(read.toLong())
                    }
                }
            }
        }
    }
}
