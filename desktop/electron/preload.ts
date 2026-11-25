/**
 * Electron Preload 桥接层
 * 通过 contextBridge 向 React 渲染进程暴露类型安全的全量 IPC 接口。
 */
import { contextBridge, ipcRenderer, clipboard } from 'electron';

export const desktopApi = {
  // 本机文件系统
  list: (dir: string) => ipcRenderer.invoke('fs:list', dir),
  drives: () => ipcRenderer.invoke('fs:drives'),
  exists: (p: string) => ipcRenderer.invoke('fs:exists', p),
  parent: (p: string) => ipcRenderer.invoke('fs:parent', p),
  special: () => ipcRenderer.invoke('fs:special'),
  open: (p: string) => ipcRenderer.invoke('fs:open', p),
  showInFolder: (p: string) => ipcRenderer.invoke('fs:showInFolder', p),
  mkdir: (dir: string, name: string) => ipcRenderer.invoke('fs:mkdir', dir, name),
  newTextFile: (dir: string) => ipcRenderer.invoke('fs:newTextFile', dir),
  newFileFromTemplate: (dir: string, name: string, templateKey: string) =>
    ipcRenderer.invoke('fs:newFileFromTemplate', dir, name, templateKey),
  search: (req: { id: string; dir: string; query: string }) =>
    ipcRenderer.invoke('fs:search', req),
  searchCancel: (id: string) => ipcRenderer.invoke('fs:searchCancel', id),
  rename: (oldPath: string, newName: string) => ipcRenderer.invoke('fs:rename', oldPath, newName),
  trash: (paths: string[]) => ipcRenderer.invoke('fs:trash', paths),
  deleteForever: (paths: string[]) => ipcRenderer.invoke('fs:delete', paths),
  copy: (sources: string[], destDir: string) => ipcRenderer.invoke('fs:copy', sources, destDir),
  move: (sources: string[], destDir: string) => ipcRenderer.invoke('fs:move', sources, destDir),
  stat: (p: string) => ipcRenderer.invoke('fs:stat', p),
  fileExtProps: (p: string) => ipcRenderer.invoke('fs:extProps', p),
  shellMenu: (paths: string[], x: number, y: number) =>
    ipcRenderer.invoke('fs:shellMenu', paths, x, y),
  openAs: (p: string) => ipcRenderer.invoke('fs:openAs', p),
  thumbs: (items: Array<{ path: string; mtime: number; size: number }>) =>
    ipcRenderer.invoke('fs:thumbs', items),
  linkThumbs: (
    conn: { host: string; port: number; password: string },
    items: Array<{ path: string; mtime: number; size: number }>,
  ) => ipcRenderer.invoke('link:thumbs', conn, items),

  // 系统剪贴板互通
  clipWriteFiles: (mode: 'copy' | 'cut', paths: string[]) =>
    ipcRenderer.invoke('clip:writeFiles', mode, paths),
  clipReadFiles: () => ipcRenderer.invoke('clip:readFiles'),
  clipClearIfMatch: (paths: string[]) => ipcRenderer.invoke('clip:clearIfMatch', paths),

  // 自动刷新监听
  watchSet: (paneId: string, dirPath: string) => ipcRenderer.invoke('watch:set', paneId, dirPath),
  watchClear: (paneId: string) => ipcRenderer.invoke('watch:clear', paneId),
  onWatchChanged: (cb: (p: { paneId: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { paneId: string }) => cb(p);
    ipcRenderer.on('watch:changed', listener);
    return () => ipcRenderer.off('watch:changed', listener);
  },
  onWatchFailed: (cb: (p: { paneId: string }) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, p: { paneId: string }) => cb(p);
    ipcRenderer.on('watch:failed', listener);
    return () => ipcRenderer.off('watch:failed', listener);
  },

  // 压缩包查看、解压、压缩
  archiveList: (req: { archivePath: string; password?: string }) =>
    ipcRenderer.invoke('archive:list', req),
  archiveCompress: (req: {
    id: string;
    format: 'zip' | '7z';
    level: string;
    password?: string;
    destDir: string;
    archiveName: string;
    sources: string[];
  }) => ipcRenderer.invoke('archive:compress', req),
  archiveExtract: (req: {
    id: string;
    archivePath: string;
    outDir: string;
    password?: string;
    entries?: string[];
  }) => ipcRenderer.invoke('archive:extract', req),
  archiveCancel: (id: string) => ipcRenderer.invoke('archive:cancel', id),
  onArchiveProgress: (
    cb: (p: { id: string; percent: number; current: string }) => void,
  ) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      p: { id: string; percent: number; current: string },
    ) => cb(p);
    ipcRenderer.on('archive:progress', listener);
    return () => ipcRenderer.off('archive:progress', listener);
  },

  // 内置互联协议（v1）
  linkTest: (conn: { host: string; port: number; password: string }) =>
    ipcRenderer.invoke('link:test', conn),
  linkRoots: (conn: { host: string; port: number; password: string }) =>
    ipcRenderer.invoke('link:roots', conn),
  linkQuickAccess: (conn: { host: string; port: number; password: string }) =>
    ipcRenderer.invoke('link:quickAccess', conn),
  linkList: (conn: { host: string; port: number; password: string }, p: string) =>
    ipcRenderer.invoke('link:list', conn, p),
  linkStat: (conn: { host: string; port: number; password: string }, p: string) =>
    ipcRenderer.invoke('link:stat', conn, p),
  linkMkdir: (conn: { host: string; port: number; password: string }, dir: string, name: string) =>
    ipcRenderer.invoke('link:mkdir', conn, dir, name),
  linkUploadEmpty: (conn: { host: string; port: number; password: string }, dir: string) =>
    ipcRenderer.invoke('link:uploadEmpty', conn, dir),
  linkUploadTemplate: (
    conn: { host: string; port: number; password: string },
    dir: string,
    name: string,
    templateKey: string,
  ) => ipcRenderer.invoke('link:uploadTemplate', conn, dir, name, templateKey),
  linkRename: (conn: { host: string; port: number; password: string }, p: string, newName: string) =>
    ipcRenderer.invoke('link:rename', conn, p, newName),
  linkDelete: (conn: { host: string; port: number; password: string }, paths: string[]) =>
    ipcRenderer.invoke('link:delete', conn, paths),
  linkOpen: (conn: { host: string; port: number; password: string }, p: string) =>
    ipcRenderer.invoke('link:open', conn, p),
  linkOpenAs: (conn: { host: string; port: number; password: string }, p: string) =>
    ipcRenderer.invoke('link:openAs', conn, p),
  linkTransfer: (req: unknown) => ipcRenderer.invoke('link:transfer', req),
  linkCancelTransfer: (id: string) => ipcRenderer.invoke('link:cancelTransfer', id),
  linkServerStatus: () => ipcRenderer.invoke('link:serverStatus'),
  linkApplyServer: () => ipcRenderer.invoke('link:applyServer'),
  linkLocalAddrs: () => ipcRenderer.invoke('link:localAddrs'),
  linkScan: () => ipcRenderer.invoke('link:scan'),
  linkCancelScan: () => ipcRenderer.invoke('link:cancelScan'),
  onTransferProgress: (
    cb: (p: {
      id: string;
      currentFile: string;
      doneBytes: number;
      totalBytes: number;
      speedBytesPerSec: number;
      doneCount: number;
      totalCount: number;
    }) => void,
  ) => {
    const listener = (_e: Electron.IpcRendererEvent, p: Parameters<typeof cb>[0]) => cb(p);
    ipcRenderer.on('link:transfer-progress', listener);
    return () => ipcRenderer.off('link:transfer-progress', listener);
  },

  // 互联聊天消息与附件
  msgList: (deviceId: string) => ipcRenderer.invoke('msg:list', deviceId),
  msgMarkRead: (deviceId: string) => ipcRenderer.invoke('msg:markRead', deviceId),
  msgUnread: () => ipcRenderer.invoke('msg:unread'),
  msgPickAttachment: () => ipcRenderer.invoke('msg:pickAttachment'),
  msgSend: (
    conn: { host: string; port: number; password: string },
    deviceId: string,
    text: string,
    attachment?: { localPath: string; name: string; size: number; mime: string } | null,
  ) => ipcRenderer.invoke('msg:send', conn, deviceId, text, attachment),
  msgOpenAttachment: (deviceId: string, fileId: string) =>
    ipcRenderer.invoke('msg:openAttachment', deviceId, fileId),
  onMessage: (cb: (m: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, m: unknown) => cb(m);
    ipcRenderer.on('link:message', listener);
    return () => ipcRenderer.off('link:message', listener);
  },
  onMsgSendProgress: (cb: (p: { deviceId: string; sent: number; total: number }) => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      p: { deviceId: string; sent: number; total: number },
    ) => cb(p);
    ipcRenderer.on('msg:send-progress', listener);
    return () => ipcRenderer.off('msg:send-progress', listener);
  },

  // 设置、主题、窗口与版本
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (s: Record<string, unknown>) => ipcRenderer.invoke('settings:set', s),
  themeGet: () => ipcRenderer.invoke('theme:get'),
  themeSet: (choice: 'system' | 'light' | 'dark') => ipcRenderer.invoke('theme:set', choice),
  onThemeUpdated: (cb: (dark: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, dark: boolean) => cb(dark);
    ipcRenderer.on('theme:updated', listener);
    return () => ipcRenderer.off('theme:updated', listener);
  },
  winMinimize: () => ipcRenderer.invoke('win:minimize'),
  winMaximize: () => ipcRenderer.invoke('win:maximize'),
  winClose: () => ipcRenderer.invoke('win:close'),
  winIsMaximized: () => ipcRenderer.invoke('win:isMaximized'),
  onMaximizeChanged: (cb: (m: boolean) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, m: boolean) => cb(m);
    ipcRenderer.on('win:maximize-changed', listener);
    return () => ipcRenderer.off('win:maximize-changed', listener);
  },
  copyText: (t: string) => clipboard.writeText(t),
};

contextBridge.exposeInMainWorld('api', desktopApi);
