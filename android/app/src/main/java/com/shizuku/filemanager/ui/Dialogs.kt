package com.shizuku.filemanager.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.shizuku.filemanager.FileManagerViewModel
import com.shizuku.filemanager.fs.*
import com.shizuku.filemanager.model.*
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

fun formatFileSize(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var v = bytes.toDouble()
    var i = 0
    while (v >= 1024 && i < units.lastIndex) {
        v /= 1024
        i++
    }
    return if (i == 0) "${v.toLong()} B" else String.format(Locale.CHINA, "%.1f %s", v, units[i])
}

fun formatTime(ms: Long): String {
    if (ms <= 0L) return ""
    return SimpleDateFormat("yyyy/MM/dd HH:mm", Locale.CHINA).format(Date(ms))
}

/** 长按菜单弹窗 */
@Composable
fun FileActionDialog(
    item: FileItem,
    isLocal: Boolean,
    onDismiss: () -> Unit,
    onOpenWith: () -> Unit,
    onCopy: () -> Unit,
    onCut: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    onProps: () -> Unit,
    onBookmark: () -> Unit,
    onViewArchive: () -> Unit,
    onCompress: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(item.name, maxLines = 1) },
        text = {
            Column {
                if (!item.isDirectory) ListItem(headlineContent = { Text("打开方式…") }, modifier = Modifier.clickable { onOpenWith(); onDismiss() })
                ListItem(headlineContent = { Text("复制") }, modifier = Modifier.clickable { onCopy(); onDismiss() })
                ListItem(headlineContent = { Text("剪切") }, modifier = Modifier.clickable { onCut(); onDismiss() })
                ListItem(headlineContent = { Text("重命名") }, modifier = Modifier.clickable { onRename(); onDismiss() })
                ListItem(headlineContent = { Text("删除") }, modifier = Modifier.clickable { onDelete(); onDismiss() })
                if (isLocal && item.kind == FileKind.ARCHIVE) {
                    ListItem(headlineContent = { Text("查看 / 解压压缩包") }, modifier = Modifier.clickable { onViewArchive(); onDismiss() })
                }
                if (isLocal) {
                    ListItem(headlineContent = { Text("压缩为 zip / 7z…") }, modifier = Modifier.clickable { onCompress(); onDismiss() })
                }
                if (isLocal && item.isDirectory) {
                    ListItem(headlineContent = { Text("添加到书签") }, modifier = Modifier.clickable { onBookmark(); onDismiss() })
                }
                ListItem(headlineContent = { Text("属性") }, modifier = Modifier.clickable { onProps(); onDismiss() })
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } }
    )
}

/** 属性弹窗 */
@Composable
fun PropertiesDialog(item: FileItem, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("属性") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("名称：${item.name}")
                Text("路径：${item.path}")
                Text("类型：${if (item.isDirectory) "文件夹" else item.kind.name}")
                if (!item.isDirectory) Text("大小：${formatFileSize(item.size)} (${item.size} B)")
                if (item.modified > 0) Text("修改时间：${formatTime(item.modified)}")
                if (item.permissions.isNotBlank()) Text("权限：${item.permissions}")
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("确定") } }
    )
}

/** 压缩包查看与解压弹窗 */
@Composable
fun ArchiveViewerDialog(
    archiveFile: File,
    onDismiss: () -> Unit,
    onExtracted: () -> Unit,
    onToast: (String) -> Unit
) {
    val scope = rememberCoroutineScope()
    var password by remember { mutableStateOf("") }
    var entries by remember { mutableStateOf<List<ArchiveEntryItem>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var progressText by remember { mutableStateOf<String?>(null) }

    fun load() {
        scope.launch {
            error = null
            runCatching { ArchiveManager.listEntries(archiveFile, password.ifBlank { null }) }
                .onSuccess { entries = it }
                .onFailure { error = it.message }
        }
    }

    LaunchedEffect(archiveFile) { load() }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("压缩包：${archiveFile.name}", maxLines = 1) },
        text = {
            Column(modifier = Modifier.heightIn(max = 380.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("密码（可选）") },
                        singleLine = true,
                        modifier = Modifier.weight(1f)
                    )
                    Spacer(Modifier.width(8.dp))
                    TextButton(onClick = { load() }) { Text("读取") }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                progressText?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
                LazyColumn(modifier = Modifier.weight(1f)) {
                    items(entries) { e ->
                        ListItem(
                            headlineContent = { Text(e.path, maxLines = 1) },
                            supportingContent = { if (!e.isDirectory) Text(formatFileSize(e.size)) }
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                scope.launch {
                    val outDir = File(archiveFile.parentFile, archiveFile.nameWithoutExtension)
                    runCatching {
                        ArchiveManager.extract(archiveFile, outDir, password.ifBlank { null }) { pct, cur ->
                            progressText = "解压中 $pct% - $cur"
                        }
                    }.onSuccess {
                        onToast("已解压到 ${outDir.name}")
                        onExtracted()
                        onDismiss()
                    }.onFailure { onToast("解压失败：${it.message}") }
                }
            }) { Text("解压到同名目录") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("关闭") } }
    )
}

/** 压缩创建弹窗 */
@Composable
fun CompressDialog(
    sources: List<File>,
    destDir: File,
    onDismiss: () -> Unit,
    onDone: () -> Unit,
    onToast: (String) -> Unit
) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(sources.firstOrNull()?.nameWithoutExtension ?: "归档") }
    var format by remember { mutableStateOf(ArchiveFormat.ZIP) }
    var password by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("创建压缩包 (${sources.size} 项)") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("文件名") }, singleLine = true)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(selected = format == ArchiveFormat.ZIP, onClick = { format = ArchiveFormat.ZIP }, label = { Text("ZIP (AES-256)") })
                    FilterChip(selected = format == ArchiveFormat.SEVEN_Z, onClick = { format = ArchiveFormat.SEVEN_Z }, label = { Text("7Z") })
                }
                OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("加密密码（可选）") }, singleLine = true)
            }
        },
        confirmButton = {
            Button(enabled = !busy && name.isNotBlank(), onClick = {
                busy = true
                scope.launch {
                    val outFile = File(destDir, "${name.trim()}.${format.ext}")
                    runCatching {
                        ArchiveManager.compress(sources, outFile, format, CompressLevel.NORMAL, password.ifBlank { null })
                    }.onSuccess {
                        onToast("已生成 ${outFile.name}")
                        onDone()
                        onDismiss()
                    }.onFailure {
                        busy = false
                        onToast("压缩失败：${it.message}")
                    }
                }
            }) { Text(if (busy) "压缩中..." else "开始压缩") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

/** SMB 添加服务器弹窗 */
@Composable
fun SmbAddDialog(onDismiss: () -> Unit, onSave: (SmbServer) -> Unit) {
    var name by remember { mutableStateOf("NAS / 电脑共享") }
    var host by remember { mutableStateOf("") }
    var share by remember { mutableStateOf("") }
    var user by remember { mutableStateOf("") }
    var pass by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("添加 SMB 服务器") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("名称") }, singleLine = true)
                OutlinedTextField(value = host, onValueChange = { host = it }, label = { Text("主机 IP") }, singleLine = true)
                OutlinedTextField(value = share, onValueChange = { share = it }, label = { Text("共享名（留空自动枚举）") }, singleLine = true)
                OutlinedTextField(value = user, onValueChange = { user = it }, label = { Text("用户名（留空匿名）") }, singleLine = true)
                OutlinedTextField(value = pass, onValueChange = { pass = it }, label = { Text("密码") }, singleLine = true)
            }
        },
        confirmButton = {
            Button(enabled = host.isNotBlank(), onClick = {
                onSave(SmbServer(name = name.ifBlank { host }, host = host.trim(), share = share.trim(), username = user.trim(), password = pass))
                onDismiss()
            }) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } }
    )
}

/** 互联设置、UDP 扫描与设备添加弹窗 */
@Composable
fun LinkManagerDialog(vm: FileManagerViewModel, onDismiss: () -> Unit, onOpenChat: (LinkServerConfig) -> Unit) {
    val scope = rememberCoroutineScope()
    val settings by vm.settings.collectAsState()
    val devices by vm.linkDevices.collectAsState()
    val serverRunning by LinkServerEvents.running.collectAsState()

    var enabled by remember { mutableStateOf(settings.linkServerEnabled) }
    var port by remember { mutableStateOf(settings.linkServerPort.toString()) }
    var pwd by remember { mutableStateOf(settings.linkServerPassword) }
    var discovered by remember { mutableStateOf<List<DiscoveredLinkDevice>>(emptyList()) }
    var scanning by remember { mutableStateOf(false) }

    var peerHost by remember { mutableStateOf("") }
    var peerPort by remember { mutableStateOf("8898") }
    var peerPwd by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Shizuku 互联（本机服务与局域网发现）") },
        text = {
            Column(modifier = Modifier.heightIn(max = 460.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("本机 UUID：${settings.deviceId.take(18)}… · 服务：${if (serverRunning) "运行中" else "未开启"}", style = MaterialTheme.typography.labelMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = enabled, onCheckedChange = { enabled = it })
                    Text("允许电脑/其他手机访问本机")
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = port, onValueChange = { port = it }, label = { Text("端口") }, modifier = Modifier.width(96.dp), singleLine = true)
                    OutlinedTextField(value = pwd, onValueChange = { pwd = it }, label = { Text("访问密码") }, modifier = Modifier.weight(1f), singleLine = true)
                }
                Button(onClick = {
                    vm.updateSettings {
                        it.copy(
                            linkServerEnabled = enabled,
                            linkServerPort = port.toIntOrNull() ?: 8898,
                            linkServerPassword = pwd.trim()
                        )
                    }
                    vm.showToast("已更新本机互联服务")
                }) { Text("保存本机服务配置") }

                HorizontalDivider()
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("局域网设备", modifier = Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    TextButton(enabled = !scanning, onClick = {
                        scanning = true
                        scope.launch {
                            discovered = LinkDiscovery.scan()
                            scanning = false
                        }
                    }) { Text(if (scanning) "扫描中..." else "UDP 扫描") }
                }
                discovered.forEach { d ->
                    ListItem(
                        headlineContent = { Text("${d.name} (${d.host}:${d.port})") },
                        trailingContent = {
                            TextButton(onClick = { peerHost = d.host; peerPort = d.port.toString() }) { Text("填入") }
                        }
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    OutlinedTextField(value = peerHost, onValueChange = { peerHost = it }, label = { Text("IP") }, modifier = Modifier.weight(1f), singleLine = true)
                    OutlinedTextField(value = peerPort, onValueChange = { peerPort = it }, label = { Text("端口") }, modifier = Modifier.width(76.dp), singleLine = true)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(value = peerPwd, onValueChange = { peerPwd = it }, label = { Text("对方密码") }, modifier = Modifier.weight(1f), singleLine = true)
                    Button(enabled = peerHost.isNotBlank() && peerPwd.isNotBlank(), onClick = {
                        scope.launch {
                            val cfg = LinkServerConfig(name = peerHost, host = peerHost.trim(), port = peerPort.toIntOrNull() ?: 8898, password = peerPwd)
                            runCatching { LinkClient(cfg).info() }
                                .onSuccess { info ->
                                    vm.saveLinkDevice(cfg.copy(id = info.id ?: cfg.id, name = info.name, type = info.type))
                                    peerHost = ""
                                    peerPwd = ""
                                }
                                .onFailure { vm.showToast("连接失败：${it.message}") }
                        }
                    }) { Text("添加") }
                }
                devices.forEach { dev ->
                    ListItem(
                        headlineContent = { Text(dev.name) },
                        supportingContent = { Text("${dev.host}:${dev.port}") },
                        trailingContent = {
                            Row {
                                IconButton(onClick = { onOpenChat(dev); onDismiss() }) { Icon(Icons.Default.Chat, "聊天") }
                                IconButton(onClick = { vm.removeLinkDevice(dev.id) }) { Icon(Icons.Default.Delete, "删除") }
                            }
                        }
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } }
    )
}

/** 互联聊天与附件弹窗 */
@Composable
fun ChatDialog(vm: FileManagerViewModel, device: LinkServerConfig, onDismiss: () -> Unit) {
    var messages by remember { mutableStateOf(vm.messageStore.list(device.id)) }
    var text by remember { mutableStateOf("") }

    LaunchedEffect(device.id) {
        vm.markChatRead(device.id)
        LinkServerEvents.incomingMessages.collect {
            if (it.deviceId == device.id) {
                messages = vm.messageStore.list(device.id)
                vm.markChatRead(device.id)
            }
        }
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("与 ${device.name} 聊天") },
        text = {
            Column(modifier = Modifier.heightIn(max = 380.dp)) {
                LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(messages) { m ->
                        Surface(
                            color = if (m.dir == "out") MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                            shape = MaterialTheme.shapes.medium,
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(Modifier.padding(8.dp)) {
                                if (m.text.isNotBlank()) Text(m.text)
                                m.attachment?.let { att ->
                                    Text("📎 ${att.name} (${formatFileSize(att.size)})", style = MaterialTheme.typography.labelMedium)
                                }
                                Text(formatTime(m.time), style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(value = text, onValueChange = { text = it }, label = { Text("输入消息") }, modifier = Modifier.weight(1f), singleLine = true)
                    IconButton(enabled = text.isNotBlank(), onClick = {
                        vm.sendChatMessage(device, text.trim(), null)
                        text = ""
                        messages = vm.messageStore.list(device.id)
                    }) { Icon(Icons.Default.Send, "发送") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } }
    )
}

/** 应用设置弹窗（工作模式 Shizuku/Root、动态取色、深浅色、隐藏文件） */
@Composable
fun SettingsDialog(vm: FileManagerViewModel, onDismiss: () -> Unit) {
    val s by vm.settings.collectAsState()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("设置") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("系统目录访问模式", style = MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    WorkMode.entries.forEach { m ->
                        FilterChip(
                            selected = s.workMode == m,
                            onClick = { vm.updateSettings { it.copy(workMode = m) } },
                            label = { Text(m.name) }
                        )
                    }
                }
                Text("主题模式", style = MaterialTheme.typography.titleSmall)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    ThemeMode.entries.forEach { tm ->
                        FilterChip(
                            selected = s.themeMode == tm,
                            onClick = { vm.updateSettings { it.copy(themeMode = tm) } },
                            label = { Text(when (tm) { ThemeMode.SYSTEM -> "跟随系统"; ThemeMode.LIGHT -> "浅色"; ThemeMode.DARK -> "深色" }) }
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = s.dynamicColor, onCheckedChange = { v -> vm.updateSettings { it.copy(dynamicColor = v) } })
                    Text("Material You 动态取色")
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = s.showHiddenFiles, onCheckedChange = { v -> vm.updateSettings { it.copy(showHiddenFiles = v) } })
                    Text("显示隐藏文件")
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("完成") } }
    )
}
