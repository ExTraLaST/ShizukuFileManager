package com.shizuku.filemanager.model

import java.util.UUID

/** 窗格排布模式：单窗格、左右双窗格、上下双窗格 */
enum class LayoutMode { SINGLE, DUAL_HORIZONTAL, DUAL_VERTICAL }

/** 列表/图标视图 */
enum class ViewMode { LIST, GRID }

/** 排序字段 */
enum class SortField { NAME, DATE, SIZE, TYPE }

/** 排序方向 */
enum class SortOrder { ASC, DESC }

/** 本地文件访问模式：普通、Shizuku、Root */
enum class WorkMode { NORMAL, SHIZUKU, ROOT }

/** 主题模式：跟随系统、浅色、深色 */
enum class ThemeMode { SYSTEM, LIGHT, DARK }

/** 消息保留策略 */
enum class MessageRetention(val key: String, val label: String, val days: Int?) {
    DAYS_7("7d", "7 天", 7),
    DAYS_30("30d", "30 天", 30),
    DAYS_90("90d", "90 天", 90),
    FOREVER("forever", "永久", null);

    companion object {
        fun fromKey(k: String?): MessageRetention = entries.find { it.key == k } ?: DAYS_30
    }
}

/** 文件分类 */
enum class FileKind { FOLDER, IMAGE, VIDEO, AUDIO, ARCHIVE, APK, DOCUMENT, OTHER }

/** 压缩包格式与级别 */
enum class ArchiveFormat(val ext: String) { ZIP("zip"), SEVEN_Z("7z") }
enum class CompressLevel(val key: String, val label: String, val zipLevel: Int) {
    FASTEST("fastest", "最快", 0),
    FAST("fast", "快速", 1),
    NORMAL("normal", "标准", 5),
    MAXIMUM("maximum", "较高", 7),
    ULTRA("ultra", "极限", 9)
}

/** 统一文件条目 */
data class FileItem(
    val name: String,
    val path: String,
    val isDirectory: Boolean,
    val size: Long = 0L,
    val modified: Long = 0L,
    val permissions: String = "",
    val kind: FileKind = if (isDirectory) FileKind.FOLDER else detectFileKind(name)
)

fun detectFileKind(name: String): FileKind {
    val ext = name.substringAfterLast('.', "").lowercase()
    return when (ext) {
        "png", "jpg", "jpeg", "gif", "bmp", "webp", "heic", "avif" -> FileKind.IMAGE
        "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "ts", "m2ts", "rmvb" -> FileKind.VIDEO
        "mp3", "flac", "wav", "ogg", "m4a", "aac", "opus", "wma", "ape" -> FileKind.AUDIO
        "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst" -> FileKind.ARCHIVE
        "apk", "apks", "xapk" -> FileKind.APK
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "json", "xml" -> FileKind.DOCUMENT
        else -> FileKind.OTHER
    }
}

/** 压缩包内条目 */
data class ArchiveEntryItem(
    val path: String,
    val name: String,
    val isDirectory: Boolean,
    val size: Long,
    val compressedSize: Long,
    val modified: Long,
    val encrypted: Boolean
)

/** 书签 */
data class Bookmark(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val path: String,
    val rootType: String = "local",
    val serverId: String? = null
)

/** SMB 服务器配置 */
data class SmbServer(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val host: String,
    val port: Int = 445,
    val username: String = "",
    val password: String = "",
    val domain: String = "",
    val share: String = "" // 为空时先枚举共享列表
)

/** 互联远程设备配置 */
data class LinkServerConfig(
    val id: String = UUID.randomUUID().toString(),
    val name: String,
    val type: String = "pc", // "pc" | "phone"
    val host: String,
    val port: Int = 8898,
    val password: String
)

/** 互联消息与附件 */
data class LinkAttachment(
    val fileId: String,
    val name: String,
    val size: Long,
    val mime: String
)

data class LinkMessage(
    val id: String = UUID.randomUUID().toString(),
    val deviceId: String,
    val dir: String, // "in" | "out"
    val text: String,
    val from: String,
    val fromId: String,
    val time: Long = System.currentTimeMillis(),
    val attachment: LinkAttachment? = null,
    val read: Boolean = dir == "out"
)

/** 窗格根源类型 */
sealed class PaneRoot {
    data object Local : PaneRoot()
    data class Smb(val server: SmbServer, val share: String? = null) : PaneRoot()
    data class Link(val device: LinkServerConfig) : PaneRoot()
}

/** 单个标签页状态 */
data class TabState(
    val id: String = UUID.randomUUID().toString(),
    val title: String = "内部存储",
    val root: PaneRoot = PaneRoot.Local,
    val path: String = "/storage/emulated/0",
    val items: List<FileItem> = emptyList(),
    val selectedPaths: Set<String> = emptySet(),
    val loading: Boolean = false,
    val error: String? = null,
    val sortField: SortField = SortField.NAME,
    val sortOrder: SortOrder = SortOrder.ASC,
    val filterText: String = "",
    val searchQuery: String = "",
    val isSearchMode: Boolean = false
)

/** 窗格（包含多个标签页） */
data class PaneState(
    val id: String,
    val tabs: List<TabState> = listOf(TabState()),
    val activeTabIndex: Int = 0
) {
    val activeTab: TabState get() = tabs.getOrElse(activeTabIndex) { tabs.first() }
}

/** 剪贴板数据 */
data class ClipboardData(
    val isCut: Boolean,
    val sourceRoot: PaneRoot,
    val items: List<FileItem>
)

/** 传输进度（含实时速度） */
data class TransferProgress(
    val active: Boolean = false,
    val title: String = "",
    val currentFile: String = "",
    val doneBytes: Long = 0L,
    val totalBytes: Long = 0L,
    val speedBytesPerSec: Long = 0L,
    val doneCount: Int = 0,
    val totalCount: Int = 0
)

/** 持久化应用设置 */
data class AppSettings(
    val deviceId: String = UUID.randomUUID().toString(),
    val deviceName: String = android.os.Build.MODEL ?: "Android",
    val layoutMode: LayoutMode = LayoutMode.SINGLE,
    val viewMode: ViewMode = ViewMode.LIST,
    val workMode: WorkMode = WorkMode.NORMAL,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val dynamicColor: Boolean = true,
    val showHiddenFiles: Boolean = false,
    val linkServerEnabled: Boolean = false,
    val linkServerPort: Int = 8898,
    val linkServerPassword: String = "",
    val messageRetention: MessageRetention = MessageRetention.DAYS_30
)
