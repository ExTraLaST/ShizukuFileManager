/**
 * Windows 电脑版前端核心类型定义
 */

export type ViewMode = 'details' | 'list' | 'icons';
export type SortField = 'name' | 'mtime' | 'type' | 'size';
export type SortOrder = 'asc' | 'desc';
export type LayoutMode = '1' | '2h' | '2v' | '4';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  extension: string;
  icon?: string;
}

export interface DriveInfo {
  path: string;
  letter: string;
  label: string;
  displayName: string;
  type: number;
  unc: string;
  free: number;
  total: number;
}

export interface LinkDevice {
  id: string;
  name: string;
  type: 'pc' | 'phone';
  host: string;
  port: number;
  password: string;
}

export interface DiscoveredDevice {
  name: string;
  type: 'pc' | 'phone';
  host: string;
  port: number;
  id: string | null;
}

export interface QuickAccessItem {
  path: string;
  name?: string;
  isFile?: boolean;
}

export interface AppSettings {
  deviceId?: string;
  theme?: ThemeChoice;
  layoutMode?: LayoutMode;
  quickAccess?: QuickAccessItem[];
  qaNames?: Record<string, string>;
  linkServer?: {
    enabled: boolean;
    port: number;
    password: string;
    name: string;
  };
  linkDevices?: LinkDevice[];
  messageRetention?: '7d' | '30d' | '90d' | 'forever';
}

export interface MessageAttachment {
  fileId: string;
  name: string;
  size: number;
  mime: string;
}

export interface MessageRecord {
  id: string;
  deviceId: string;
  dir: 'in' | 'out';
  text: string;
  from: string;
  fromId: string;
  time: number;
  attachment: MessageAttachment | null;
  read: boolean;
}

export interface ArchiveEntry {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  packedSize: number;
  modified: number;
  encrypted: boolean;
}

export interface PaneTab {
  id: string;
  title: string;
  kind: 'thispc' | 'local' | 'remote';
  path: string;
  deviceId?: string;
  history: Array<{ kind: 'thispc' | 'local' | 'remote'; path: string; deviceId?: string }>;
  historyIndex: number;
  viewMode: ViewMode;
  sortField: SortField;
  sortOrder: SortOrder;
  filterText: string;
  searchQuery: string;
  searchMode: boolean;
}

export interface ClipboardState {
  mode: 'copy' | 'cut';
  srcKind: 'local' | 'remote';
  deviceId?: string;
  items: FileItem[];
}

export interface TransferProgressEvent {
  id: string;
  currentFile: string;
  doneBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  doneCount: number;
  totalCount: number;
}

export interface ArchiveProgressEvent {
  id: string;
  percent: number;
  current: string;
}

export interface DesktopApi {
  list(dir: string): Promise<FileItem[]>;
  drives(): Promise<DriveInfo[]>;
  exists(p: string): Promise<boolean>;
  parent(p: string): Promise<string>;
  special(): Promise<Record<string, string>>;
  open(p: string): Promise<string>;
  showInFolder(p: string): Promise<boolean>;
  mkdir(dir: string, name: string): Promise<string>;
  newTextFile(dir: string): Promise<string>;
  newFileFromTemplate(dir: string, name: string, templateKey: string): Promise<string>;
  search(req: { id: string; dir: string; query: string }): Promise<{
    items: FileItem[];
    scanned: number;
    truncated: boolean;
    cancelled: boolean;
  }>;
  searchCancel(id: string): Promise<boolean>;
  rename(oldPath: string, newName: string): Promise<string>;
  trash(paths: string[]): Promise<boolean>;
  deleteForever(paths: string[]): Promise<boolean>;
  copy(sources: string[], destDir: string): Promise<boolean>;
  move(sources: string[], destDir: string): Promise<boolean>;
  stat(p: string): Promise<{
    path: string;
    name: string;
    isDirectory: boolean;
    size: number;
    mtime: number;
    ctime: number;
    birthtime: number;
  }>;
  fileExtProps(p: string): Promise<Record<string, string>>;
  shellMenu(paths: string[], x: number, y: number): Promise<{ ok: boolean; executed?: boolean; error?: string }>;
  openAs(p: string): Promise<{ ok: boolean; error?: string }>;
  thumbs(items: Array<{ path: string; mtime: number; size: number }>): Promise<Record<string, string>>;
  linkThumbs(
    conn: { host: string; port: number; password: string },
    items: Array<{ path: string; mtime: number; size: number }>,
  ): Promise<Record<string, string>>;

  clipWriteFiles(mode: 'copy' | 'cut', paths: string[]): Promise<boolean>;
  clipReadFiles(): Promise<{ mode: 'copy' | 'cut'; paths: string[] } | null>;
  clipClearIfMatch(paths: string[]): Promise<boolean>;

  watchSet(paneId: string, dirPath: string): Promise<'none' | 'same' | 'watch' | 'poll' | 'error'>;
  watchClear(paneId: string): Promise<boolean>;
  onWatchChanged(cb: (p: { paneId: string }) => void): () => void;
  onWatchFailed(cb: (p: { paneId: string }) => void): () => void;

  archiveList(req: { archivePath: string; password?: string }): Promise<{
    ok: boolean;
    entries?: ArchiveEntry[];
    code?: string;
    error?: string;
  }>;
  archiveCompress(req: {
    id: string;
    format: 'zip' | '7z';
    level: string;
    password?: string;
    destDir: string;
    archiveName: string;
    sources: string[];
  }): Promise<{ ok: boolean; outPath?: string; cancelled?: boolean; error?: string }>;
  archiveExtract(req: {
    id: string;
    archivePath: string;
    outDir: string;
    password?: string;
    entries?: string[];
  }): Promise<{ ok: boolean; outDir?: string; cancelled?: boolean; code?: string; error?: string }>;
  archiveCancel(id: string): Promise<boolean>;
  onArchiveProgress(cb: (p: ArchiveProgressEvent) => void): () => void;

  linkTest(conn: { host: string; port: number; password: string }): Promise<{
    ok: true;
    name: string;
    type: 'pc' | 'phone';
    version: number;
    id?: string;
  }>;
  linkRoots(conn: { host: string; port: number; password: string }): Promise<{
    ok: true;
    roots: Array<{ name: string; path: string; free: number; total: number }>;
  }>;
  linkQuickAccess(conn: { host: string; port: number; password: string }): Promise<{
    ok: true;
    items: Array<{ name: string; path: string }>;
  }>;
  linkList(conn: { host: string; port: number; password: string }, p: string): Promise<{
    ok: true;
    items: Array<{ name: string; path: string; isDirectory: boolean; size: number; modified: number }>;
  }>;
  linkStat(conn: { host: string; port: number; password: string }, p: string): Promise<{
    ok: true;
    exists: boolean;
    isDirectory: boolean;
    size: number;
    modified: number;
  }>;
  linkMkdir(conn: { host: string; port: number; password: string }, dir: string, name: string): Promise<{ ok: true }>;
  linkUploadEmpty(conn: { host: string; port: number; password: string }, dir: string): Promise<string>;
  linkUploadTemplate(
    conn: { host: string; port: number; password: string },
    dir: string,
    name: string,
    templateKey: string,
  ): Promise<string>;
  linkRename(conn: { host: string; port: number; password: string }, p: string, newName: string): Promise<{ ok: true; path: string }>;
  linkDelete(conn: { host: string; port: number; password: string }, paths: string[]): Promise<boolean>;
  linkOpen(conn: { host: string; port: number; password: string }, p: string): Promise<{ ok: boolean; error?: string }>;
  linkOpenAs(conn: { host: string; port: number; password: string }, p: string): Promise<{ ok: boolean; error?: string }>;
  linkTransfer(req: unknown): Promise<{ ok: boolean; error?: string }>;
  linkCancelTransfer(id: string): Promise<boolean>;
  linkServerStatus(): Promise<{ running: boolean; port: number; error: string }>;
  linkApplyServer(): Promise<{ running: boolean; port: number; error: string }>;
  linkLocalAddrs(): Promise<string[]>;
  linkScan(): Promise<DiscoveredDevice[]>;
  linkCancelScan(): Promise<boolean>;
  onTransferProgress(cb: (p: TransferProgressEvent) => void): () => void;

  msgList(deviceId: string): Promise<MessageRecord[]>;
  msgMarkRead(deviceId: string): Promise<boolean>;
  msgUnread(): Promise<Record<string, number>>;
  msgPickAttachment(): Promise<{ localPath: string; name: string; size: number; mime: string } | null>;
  msgSend(
    conn: { host: string; port: number; password: string },
    deviceId: string,
    text: string,
    attachment?: { localPath: string; name: string; size: number; mime: string } | null,
  ): Promise<MessageRecord>;
  msgOpenAttachment(deviceId: string, fileId: string): Promise<{ ok: boolean; error?: string }>;
  onMessage(cb: (m: MessageRecord) => void): () => void;
  onMsgSendProgress(cb: (p: { deviceId: string; sent: number; total: number }) => void): () => void;

  getVersion(): Promise<string>;
  settingsGet(): Promise<AppSettings>;
  settingsSet(s: Partial<AppSettings>): Promise<AppSettings>;
  themeGet(): Promise<{ choice: ThemeChoice; dark: boolean }>;
  themeSet(choice: ThemeChoice): Promise<{ choice: ThemeChoice; dark: boolean }>;
  onThemeUpdated(cb: (dark: boolean) => void): () => void;
  winMinimize(): Promise<void>;
  winMaximize(): Promise<boolean>;
  winClose(): Promise<void>;
  winIsMaximized(): Promise<boolean>;
  onMaximizeChanged(cb: (m: boolean) => void): () => void;
  copyText(t: string): void;
}

declare global {
  interface Window {
    api: DesktopApi;
  }
}
