package com.shizuku.filemanager.ui.theme

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import com.shizuku.filemanager.model.ThemeMode

private val FallbackLightColors = lightColorScheme(
    primary = Color(0xFF0067C0),
    secondary = Color(0xFF535F70),
    tertiary = Color(0xFF6B5778)
)

private val FallbackDarkColors = darkColorScheme(
    primary = Color(0xFF60CDFF),
    secondary = Color(0xFFBBC7DB),
    tertiary = Color(0xFFD6BEE4)
)

/**
 * Material 3 动态取色（Android 12+）与深浅色主题
 */
@Composable
fun ShizukuTheme(
    themeMode: ThemeMode,
    dynamicColor: Boolean,
    content: @Composable () -> Unit
) {
    val darkTheme = when (themeMode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    val context = LocalContext.current
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> FallbackDarkColors
        else -> FallbackLightColors
    }
    MaterialTheme(colorScheme = colorScheme, content = content)
}
