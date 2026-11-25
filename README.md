# Shizuku 文件管理器（Windows 电脑版 + Android 安卓版）

一套跨端双平台文件管理器，**内置 Shizuku 互联协议 v1**（支持手机 ↔ 电脑、电脑 ↔ 电脑、手机 ↔ 手机双向文件浏览、Range 流播、远程缩略图、UDP 局域网自动发现与聊天消息/附件收发），并兼容工作区现有参考版本（电脑版 v1.11.0 / 安卓版 v1.23）。

## 工程结构

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md)：共用互联协议 v1 完整规范
- [`desktop/`](desktop/)：Windows 11 风格多窗格电脑版（Electron + React 18 + TypeScript + Vite）
- [`android/`](android/)：Material 3 动态取色安卓版（Kotlin + Jetpack Compose + Shizuku + SMBJ + Media3）

## 电脑版构建与测试

```powershell
cd desktop
# 安装依赖（如需加速 Electron 二进制下载，可先设置 $env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'）
npm install

# 编译主进程 + React 生产包
npm run build

# 运行全套后端服务与互联协议 v1 自动化测试
npm test

# 启动桌面应用（配置持久化于 %APPDATA%\Shizuku文件管理器\settings.json）
npm start

# 打包 Windows 便携 ZIP 与 NSIS 安装包（产物输出至 desktop/release/）
npm run dist:win
```

## 安卓版构建

使用 Android Studio（JDK 17 + Android SDK 35）直接打开 [`android/`](android/) 目录并同步 Gradle，或执行：

```powershell
cd android
./gradlew assembleDebug
```
