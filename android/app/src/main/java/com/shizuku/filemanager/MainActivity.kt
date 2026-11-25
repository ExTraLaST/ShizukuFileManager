package com.shizuku.filemanager

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import com.shizuku.filemanager.ui.MainScreen
import com.shizuku.filemanager.ui.theme.ShizukuTheme

/**
 * 安卓版主入口 Activity
 * 开启 Edge-to-Edge 全面屏显示、自动检测所有文件访问权限并应用 Material 3 动态取色。
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        ensureStoragePermission()

        setContent {
            val vm: FileManagerViewModel = viewModel()
            val settings by vm.settings.collectAsState()
            ShizukuTheme(
                themeMode = settings.themeMode,
                dynamicColor = settings.dynamicColor
            ) {
                MainScreen(vm)
            }
        }
    }

    private fun ensureStoragePermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !Environment.isExternalStorageManager()) {
            runCatching {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                        Uri.parse("package:$packageName")
                    )
                )
            }
        }
    }
}
