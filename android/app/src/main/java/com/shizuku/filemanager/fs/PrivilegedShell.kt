package com.shizuku.filemanager.fs

import android.content.ComponentName
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import com.shizuku.filemanager.BuildConfig
import com.shizuku.filemanager.model.FileItem
import rikka.shizuku.Shizuku
import java.io.BufferedReader
import java.io.InputStreamReader
import kotlin.system.exitProcess

/**
 * 运行在 Shizuku 高权限独立进程中的 Shell UserService
 */
class ShellService : IShellService.Stub() {
    override fun destroy() {
        exitProcess(0)
    }

    override fun exec(command: String): String {
        val p = ProcessBuilder("sh", "-c", command).redirectErrorStream(true).start()
        val out = BufferedReader(InputStreamReader(p.inputStream)).use { it.readText() }
        p.waitFor()
        return out
    }

    override fun execCode(command: String): Int {
        val p = ProcessBuilder("sh", "-c", command).redirectErrorStream(true).start()
        p.inputStream.bufferedReader().use { it.readText() }
        return p.waitFor()
    }
}

/**
 * Shizuku 权限检测与 UserService 绑定桥接器
 */
object ShizukuBridge {
    @Volatile
    private var shellService: IShellService? = null

    private val userServiceArgs by lazy {
        Shizuku.UserServiceArgs(ComponentName(BuildConfig.APPLICATION_ID, ShellService::class.java.name))
            .daemon(false)
            .processNameSuffix("shell")
            .debuggable(BuildConfig.DEBUG)
            .version(BuildConfig.VERSION_CODE)
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            shellService = IShellService.Stub.asInterface(service)
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            shellService = null
        }
    }

    fun isAvailable(): Boolean = runCatching { Shizuku.pingBinder() }.getOrDefault(false)

    fun hasPermission(): Boolean = runCatching {
        isAvailable() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    fun requestPermission(requestCode: Int = 1001) {
        if (isAvailable() && !hasPermission()) {
            Shizuku.requestPermission(requestCode)
        }
    }

    fun bindIfReady() {
        if (hasPermission() && shellService == null) {
            runCatching { Shizuku.bindUserService(userServiceArgs, connection) }
        }
    }

    fun exec(cmd: String): String? = runCatching {
        if (shellService == null) bindIfReady()
        shellService?.exec(cmd)
    }.getOrNull()

    fun execCode(cmd: String): Int = runCatching {
        if (shellService == null) bindIfReady()
        shellService?.execCode(cmd) ?: -1
    }.getOrDefault(-1)
}

/**
 * Root Shell 执行器（su -c）
 */
object RootShell {
    fun isRootAvailable(): Boolean = runCatching {
        val p = ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().use { it.readText() }
        p.waitFor() == 0 && out.contains("uid=0")
    }.getOrDefault(false)

    fun exec(cmd: String): String {
        val p = ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().use { it.readText() }
        p.waitFor()
        return out
    }

    fun execCode(cmd: String): Int {
        val p = ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start()
        p.inputStream.bufferedReader().use { it.readText() }
        return p.waitFor()
    }
}

/**
 * Shell 命令工具：单引号安全转义 + 解析 `ls -la --time-style=full-iso` 输出
 */
object ShellParser {
    fun quote(s: String): String = "'" + s.replace("'", "'\"'\"'") + "'"

    fun parseLsOutput(parentDir: String, output: String, showHidden: Boolean): List<FileItem> {
        val base = if (parentDir == "/") "" else parentDir.trimEnd('/')
        val results = mutableListOf<FileItem>()
        output.lineSequence().forEach { rawLine ->
            val line = rawLine.trim()
            if (line.isEmpty() || line.startsWith("total ")) return@forEach
            // 兼容 Android toybox ls -la 格式: drwxr-xr-x 2 root root 4096 2026-01-01 12:00 name
            val parts = line.split(Regex("\\s+"), limit = 8)
            if (parts.size < 8) return@forEach
            val perms = parts[0]
            val nameRaw = parts[7]
            val name = nameRaw.substringBefore(" -> ")
            if (name == "." || name == "..") return@forEach
            if (!showHidden && name.startsWith(".")) return@forEach
            val isDir = perms.startsWith("d")
            val size = parts[4].toLongOrNull() ?: 0L
            results.add(
                FileItem(
                    name = name,
                    path = "$base/$name",
                    isDirectory = isDir,
                    size = if (isDir) 0L else size,
                    modified = 0L,
                    permissions = perms
                )
            )
        }
        return results
    }
}
