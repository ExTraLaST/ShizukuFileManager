# Shizuku File Manager ProGuard / R8 rules

# Keep Shizuku AIDL interfaces & UserService classes
-keep class com.shizuku.filemanager.fs.IShellService { *; }
-keep class com.shizuku.filemanager.fs.IShellService$* { *; }
-keep class com.shizuku.filemanager.fs.ShellUserService { *; }

# Keep SMBJ / BouncyCastle classes referenced reflectively
-dontwarn com.hierynomus.**
-dontwarn org.bouncycastle.**
-dontwarn org.apache.commons.compress.**
-dontwarn com.github.junrar.**
