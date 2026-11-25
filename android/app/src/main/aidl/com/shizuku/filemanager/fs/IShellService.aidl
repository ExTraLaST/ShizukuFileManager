package com.shizuku.filemanager.fs;

/**
 * Shizuku UserService 跨进程 Shell 服务接口
 * 运行在 ADB/Root 高权限进程中，用于安全读写受限系统目录（如 /Android/data、/data 等）。
 */
interface IShellService {
    void destroy() = 16777114;
    String exec(String command) = 1;
    int execCode(String command) = 2;
}
