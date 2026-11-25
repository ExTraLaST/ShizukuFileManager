/**
 * Shizuku 文件管理器 — Electron 主进程
 * 设置文件持久化路径：%APPDATA%\Shizuku文件管理器\settings.json
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  nativeTheme,
  Notification,
  dialog,
  screen,
} from 'electron';
import path from 'path';
import fs from 'fs';
import { promises as fsp } from 'fs';
import { execFile, spawn } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import {
  createLinkServer,
  wireJoin,
  nextName,
  type LinkServerInstance,
  type QuickAccessInput,
} from './services/link-server';
import { createLinkClient, scanLinkDevices, type LinkConnection } from './services/link-client';
import {
  createMediaProxy,
  probeStream,
  isMediaPath,
  buildPlaylistContent,
  AUDIO_EXTS,
} from './services/link-proxy';
import {
  parseWmicCsv,
  parseNetUse,
  parseVolOutput,
  driveDisplayName,
  decodeConsoleOutput,
  type DriveMetaEntry,
} from './services/drive-utils';
import { searchLocal } from './services/search-utils';
import { getTemplateBuffer } from './services/file-templates';
import { createRateTracker, createSerializer } from './services/transfer-rate';
import { getExtendedProps } from './services/ext-props';
import {
  createMessageStore,
  normalizeRetention,
  MAX_TEXT_LEN,
  type MessageRecord,
  type MessageStore,
} from './services/message-store';
import { extractCoverArt, extForMime } from './services/cover-art';
import {
  writeFiles as clipWriteFiles,
  readFiles as clipReadFiles,
  clearIfMatch as clipClearIfMatch,
} from './services/sys-clipboard';
import { openWithDefaultApp } from './services/default-app';
import { createFolderWatcher } from './services/folder-watch';
import {
  validArchiveBaseName,
  buildCompressArgs,
  buildExtractArgs,
  classifyError,
  runSevenZip,
  listArchiveEntries,
} from './services/archive';

// 确保配置目录严格落盘到 %APPDATA%\Shizuku文件管理器\settings.json
app.setName('Shizuku文件管理器');

let mainWindow: BrowserWindow | null = null;
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

interface AppSettings {
  deviceId?: string;
  theme?: 'system' | 'light' | 'dark';
  layoutMode?: '1' | '2h' | '2v' | '4';
  quickAccess?: Array<{ path: string; name?: string; isFile?: boolean }>;
  qaNames?: Record<string, string>;
  linkServer?: { enabled: boolean; port: number; password: string; name: string };
  linkDevices?: Array<{
    id?: string;
    name: string;
    type: 'pc' | 'phone';
    host: string;
    port: number;
    password: string;
  }>;
  messageRetention?: '7d' | '30d' | '90d' | 'forever';
  [key: string]: unknown;
}

function loadSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as AppSettings;
  } catch {
    return {};
  }
}

function saveSettings(s: AppSettings): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
  } catch {}
}

function ensureDeviceId(): string {
  const s = loadSettings();
  if (typeof s.deviceId === 'string' && s.deviceId) return s.deviceId;
  const id = crypto.randomUUID();
  s.deviceId = id;
  saveSettings(s);
  return id;
}

// ---------------- 资源路径定位（7za.exe / ShellMenu.exe） ----------------

function findBundledExe(fileName: string): string | null {
  const candidates = [
    path.join(process.resourcesPath || '', fileName),
    path.join(__dirname, '..', 'resources', fileName),
    path.join(app.getAppPath(), 'resources', fileName),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

// ---------------- 驱动器与网络盘探测 ----------------

function listDrives(): string[] {
  const drives: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.existsSync(root)) drives.push(root);
    } catch {}
  }
  return drives;
}

function getVolumeLabels(): Promise<Record<string, DriveMetaEntry>> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({});
      return;
    }
    execFile(
      'wmic',
      ['logicaldisk', 'get', 'DeviceID,DriveType,VolumeName', '/format:csv'],
      { timeout: 8000, encoding: 'buffer' },
      (err, stdout) => {
        resolve(!err && stdout ? parseWmicCsv(decodeConsoleOutput(stdout)) : {});
      },
    );
  });
}

function getMappedDrives(): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(new Map());
      return;
    }
    execFile('cmd', ['/c', 'chcp 65001 >nul & net use'], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && stdout ? parseNetUse(stdout) : new Map());
    });
  });
}

function getVolLabels(roots: string[], mapped: Map<string, string>): Promise<Record<string, string>> {
  const targets = roots
    .map((r) => r.slice(0, 2).toUpperCase())
    .filter((letter) => /^[A-Z]:$/.test(letter) && !mapped.has(letter));
  return Promise.all(
    targets.map(
      (letter) =>
        new Promise<[string, string]>((resolve) => {
          if (process.platform !== 'win32') {
            resolve([letter, '']);
            return;
          }
          execFile(
            'cmd',
            ['/c', `chcp 65001 >nul & vol ${letter}`],
            { timeout: 8000 },
            (err, stdout) => {
              resolve([letter, !err && stdout ? parseVolOutput(stdout) : '']);
            },
          );
        }),
    ),
  ).then((pairs) => {
    const out: Record<string, string> = {};
    for (const [letter, label] of pairs) if (label) out[letter] = label;
    return out;
  });
}

async function getDriveMeta(roots: string[]): Promise<Record<string, DriveMetaEntry>> {
  const meta = await getVolumeLabels();
  const wmicEmpty = Object.keys(meta).length === 0;
  const mapped = await getMappedDrives();
  for (const [letter, unc] of mapped) {
    if (!meta[letter]) meta[letter] = { label: '', type: 4 };
    meta[letter].unc = unc;
  }
  if (wmicEmpty) {
    const volLabels = await getVolLabels(roots, mapped);
    for (const [letter, label] of Object.entries(volLabels)) {
      if (!meta[letter]) meta[letter] = { label, type: 3 };
      else if (!meta[letter].label) meta[letter].label = label;
    }
  }
  return meta;
}

let driveMetaCache: Record<string, DriveMetaEntry> | null = null;
let driveMetaCacheAt = 0;
async function cachedDriveMeta(): Promise<Record<string, DriveMetaEntry>> {
  const now = Date.now();
  if (driveMetaCache && now - driveMetaCacheAt < 5 * 60 * 1000) return driveMetaCache;
  try {
    driveMetaCache = await getDriveMeta(listDrives());
  } catch {
    driveMetaCache = {};
  }
  driveMetaCacheAt = now;
  return driveMetaCache;
}

async function isNetworkPath(dirPath: string): Promise<boolean> {
  if (process.platform !== 'win32' || typeof dirPath !== 'string') return false;
  if (dirPath.startsWith('\\\\')) return true;
  const m = dirPath.match(/^([A-Za-z]):\\/);
  if (!m) return false;
  const meta = await cachedDriveMeta();
  const d = meta[`${m[1].toUpperCase()}:`];
  return !!(d && d.type === 4);
}

// ---------------- 图标与缩略图缓存 ----------------

const iconCache = new Map<string, string>();
const iconPathCache = new Map<string, string>();
const PER_FILE_ICON_EXTS = new Set(['.exe', '.lnk', '.ico']);

async function iconFor(filePath: string, isDirectory: boolean): Promise<string> {
  if (isDirectory) return '';
  const ext = path.extname(filePath).toLowerCase() || '<file>';
  const perFile = PER_FILE_ICON_EXTS.has(ext);
  const cache = perFile ? iconPathCache : iconCache;
  const key = perFile ? filePath : ext;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  try {
    const img = await app.getFileIcon(filePath, { size: 'normal' });
    const url = img.toDataURL();
    if (cache.size > 400) cache.clear();
    cache.set(key, url);
    return url;
  } catch {
    return '';
  }
}

const THUMB_CACHE_MAX = 300;
const THUMB_BATCH_MAX = 100;
let thumbDirReady = false;

function thumbDir(): string {
  const dir = path.join(app.getPath('temp'), 'ShizukuExplorer-thumbs');
  if (!thumbDirReady) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(dir)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {}
      }
    } catch {}
    thumbDirReady = true;
  }
  return dir;
}

function thumbCacheKey(p: string, mtime: number, size: number, thumbPx = 256): string {
  return crypto.createHash('sha256').update(`${p}|${mtime}|${size}|${thumbPx}`).digest('hex');
}

function thumbCacheFindByKey(key: string): string | null {
  for (const ext of ['.png', '.jpg', '.gif', '.webp', '.bmp']) {
    const c = path.join(thumbDir(), key + ext);
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function thumbFileUrl(absPath: string): string {
  return `file:///${absPath.split(path.sep).join('/')}`;
}

function pruneThumbCache(): void {
  try {
    const dir = thumbDir();
    const entries = fs
      .readdirSync(dir)
      .map((f) => {
        try {
          return { f, m: fs.statSync(path.join(dir, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; m: number } => Boolean(x))
      .sort((a, b) => a.m - b.m);
    while (entries.length > THUMB_CACHE_MAX) {
      const oldest = entries.shift()!;
      try {
        fs.unlinkSync(path.join(dir, oldest.f));
      } catch {}
    }
  } catch {}
}

function extForThumbBytes(contentType: string, buffer: Buffer): string {
  const ct = String(contentType || '')
    .toLowerCase()
    .split(';')[0]
    .trim();
  if (ct === 'image/png') return '.png';
  if (ct === 'image/gif') return '.gif';
  if (ct === 'image/webp') return '.webp';
  if (ct === 'image/bmp') return '.bmp';
  if (ct === 'image/jpeg') return '.jpg';
  if (buffer.length >= 12) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
      return '.png';
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return '.gif';
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
      return '.webp';
  }
  return '.jpg';
}

async function fetchThumbnails(
  items: Array<{ path: string; mtime: number; size: number }>,
  thumbPx = 256,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const misses: Array<{ path: string; mtime: number; size: number }> = [];
  for (const it of items.slice(0, THUMB_BATCH_MAX)) {
    if (!it || typeof it.path !== 'string') continue;
    const key = thumbCacheKey(it.path, it.mtime || 0, it.size || 0, thumbPx);
    const cached = thumbCacheFindByKey(key);
    if (cached) {
      out[it.path] = thumbFileUrl(cached);
      continue;
    }
    misses.push(it);
  }
  if (misses.length === 0) return out;

  const exe = findBundledExe('ShellMenu.exe');
  if (process.platform === 'win32' && exe) {
    const dir = thumbDir();
    const tag = crypto.randomUUID();
    const listFile = path.join(dir, `list-${tag}.txt`);
    const batchDir = path.join(dir, `batch-${tag}`);
    try {
      fs.mkdirSync(batchDir, { recursive: true });
      fs.writeFileSync(listFile, misses.map((it, i) => `${i}|${it.path}`).join('\r\n'), 'utf8');
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const child = spawn(
          exe,
          ['--thumb', '--size', String(thumbPx), '--list', listFile, '--out', batchDir],
          { windowsHide: true },
        );
        const t = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          done();
        }, 20000);
        child.on('error', () => {
          clearTimeout(t);
          done();
        });
        child.on('close', () => {
          clearTimeout(t);
          done();
        });
      });
      for (let i = 0; i < misses.length; i++) {
        const gen = path.join(batchDir, `${i}.png`);
        if (fs.existsSync(gen)) {
          const it = misses[i];
          const dest = path.join(
            dir,
            `${thumbCacheKey(it.path, it.mtime || 0, it.size || 0, thumbPx)}.png`,
          );
          try {
            fs.renameSync(gen, dest);
            out[it.path] = thumbFileUrl(dest);
          } catch {}
        }
      }
    } catch {}
    try {
      fs.unlinkSync(listFile);
    } catch {}
    try {
      fs.rmSync(batchDir, { recursive: true, force: true });
    } catch {}
  }

  // 音频内嵌封面兜底
  for (const it of misses) {
    if (out[it.path]) continue;
    if (!AUDIO_EXTS.has(path.extname(it.path).toLowerCase())) continue;
    const cover = extractCoverArt(it.path);
    if (!cover) continue;
    const ext = extForMime(cover.mime);
    const dest = path.join(
      thumbDir(),
      `${thumbCacheKey(it.path, it.mtime || 0, it.size || 0, thumbPx)}${ext}`,
    );
    try {
      fs.writeFileSync(dest, cover.buffer);
      out[it.path] = thumbFileUrl(dest);
    } catch {}
  }
  pruneThumbCache();
  return out;
}

// ---------------- 原生右键菜单与打开方式（ShellMenu.exe） ----------------

function runShellMenu(paths: string[], x: number, y: number) {
  return new Promise<{ ok: boolean; executed?: boolean; error?: string }>((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: '仅支持 Windows' });
      return;
    }
    const exe = findBundledExe('ShellMenu.exe');
    if (!exe) {
      resolve({ ok: false, error: 'ShellMenu.exe 未找到' });
      return;
    }
    let px = Math.round(x);
    let py = Math.round(y);
    try {
      const disp = screen.getDisplayNearestPoint({ x: px, y: py });
      const scale = disp?.scaleFactor || 1;
      px = Math.round(x * scale);
      py = Math.round(y * scale);
    } catch {}
    const outFile = path.join(app.getPath('temp'), `shizuku-shellmenu-${crypto.randomUUID()}.txt`);
    let settled = false;
    let poll: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout | null = null;
    const done = (r: { ok: boolean; executed?: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      try {
        fs.unlinkSync(outFile);
      } catch {}
      resolve(r);
    };
    const child = spawn(
      exe,
      ['--menu', '--x', String(px), '--y', String(py), '--out', outFile, ...paths],
      { windowsHide: true },
    );
    try {
      child.unref();
    } catch {}
    poll = setInterval(() => {
      try {
        if (!fs.existsSync(outFile)) return;
        const raw = fs.readFileSync(outFile, 'utf8').trim();
        if (!raw) return;
        if (raw.startsWith('error')) done({ ok: false, error: raw.replace(/^error\s*/, '') });
        else done({ ok: true, executed: raw.startsWith('ok') });
      } catch {}
    }, 100);
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      done({ ok: false, error: '菜单超时' });
    }, 5 * 60 * 1000);
    child.on('error', (e) => done({ ok: false, error: e.message }));
    child.on('close', () => {
      if (settled) return;
      let raw = '';
      try {
        raw = fs.readFileSync(outFile, 'utf8').trim();
      } catch {}
      if (raw.startsWith('error')) done({ ok: false, error: raw.replace(/^error\s*/, '') });
      else if (raw) done({ ok: true, executed: raw.startsWith('ok') });
      else done({ ok: false, error: '系统菜单异常退出' });
    });
  });
}

function openWithDialog(filePath: string) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: '打开方式仅支持 Windows' });
      return;
    }
    const exe = findBundledExe('ShellMenu.exe');
    if (!exe) {
      resolve({ ok: false, error: 'ShellMenu.exe 未找到' });
      return;
    }
    const outFile = path.join(app.getPath('temp'), `shizuku-openwith-${crypto.randomUUID()}.txt`);
    let settled = false;
    let poll: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout | null = null;
    const done = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      try {
        fs.unlinkSync(outFile);
      } catch {}
      resolve(r);
    };
    const child = spawn(exe, ['--openwith', '--file', filePath, '--out', outFile], {
      windowsHide: true,
    });
    try {
      child.unref();
    } catch {}
    poll = setInterval(() => {
      try {
        if (!fs.existsSync(outFile)) return;
        const raw = fs.readFileSync(outFile, 'utf8').trim();
        if (!raw) return;
        if (raw.startsWith('error')) done({ ok: false, error: raw.replace(/^error\s*/, '') });
        else done({ ok: true });
      } catch {}
    }, 100);
    timer = setTimeout(() => done({ ok: true }), 15000);
    child.on('error', (e) => done({ ok: false, error: e.message }));
  });
}

// ---------------- 内置互联服务端、流播代理与消息存储 ----------------

let linkServer: LinkServerInstance | null = null;
let linkServerStatus = { running: false, port: 0, error: '' };
let messageStore: MessageStore | null = null;
let cachedQuickAccess: QuickAccessInput[] = [];
let cachedQaNames: Record<string, string> = {};

function getMessageStore(): MessageStore {
  if (!messageStore) messageStore = createMessageStore(app.getPath('userData'));
  return messageStore;
}

function localLanAddrs(): string[] {
  const out: string[] = [];
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const a of ifs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const mediaProxy = createMediaProxy({
  resolveHost: () => {
    const a = localLanAddrs();
    return a.length ? a[0] : null;
  },
});

const folderWatcher = createFolderWatcher({
  onChanged: (paneId) => mainWindow?.webContents.send('watch:changed', { paneId }),
  onFailed: (paneId) => mainWindow?.webContents.send('watch:failed', { paneId }),
});

const QA_DEFAULT_DEFS = [
  { key: 'desktop', label: '桌面' },
  { key: 'documents', label: '文档' },
  { key: 'downloads', label: '下载' },
  { key: 'pictures', label: '图片' },
  { key: 'music', label: '音乐' },
  { key: 'videos', label: '视频' },
] as const;

function defaultQuickAccess(): QuickAccessInput[] {
  const out: QuickAccessInput[] = [];
  for (const d of QA_DEFAULT_DEFS) {
    try {
      const p = app.getPath(d.key);
      if (p) out.push({ path: p, name: cachedQaNames[d.key]?.trim() || d.label });
    } catch {}
  }
  return out;
}

function onLinkMessage(record: MessageRecord) {
  try {
    if (Notification.isSupported()) {
      const title = `${record.from || '互联设备'} 发来消息`;
      const body =
        record.text?.slice(0, 50) ||
        (record.attachment ? `发来附件：${record.attachment.name}` : '发来一条消息');
      const n = new Notification({ title, body });
      n.on('click', () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      });
      n.show();
    }
  } catch {}
  mainWindow?.webContents.send('link:message', record);
}

const applyLinkServerSerialized = createSerializer();

async function applyLinkServerSettings() {
  return applyLinkServerSerialized(async () => {
    if (linkServer) {
      try {
        await linkServer.stop();
      } catch {}
      linkServer = null;
    }
    const s = loadSettings();
    const cfg = s.linkServer;
    if (!cfg || !cfg.enabled) {
      linkServerStatus = { running: false, port: 0, error: '' };
      return linkServerStatus;
    }
    if (!cfg.password) {
      linkServerStatus = { running: false, port: 0, error: '请先设置访问密码' };
      return linkServerStatus;
    }
    const srv = createLinkServer({
      port: cfg.port || 8898,
      password: cfg.password,
      name: cfg.name || os.hostname(),
      deviceId: ensureDeviceId(),
      getQuickAccess: () => [...defaultQuickAccess(), ...cachedQuickAccess],
      messageStore: getMessageStore(),
      onMessage: onLinkMessage,
      generateThumbnail: async (localPath, meta) => {
        const res = await fetchThumbnails(
          [{ path: localPath, mtime: meta.mtime, size: meta.size }],
          meta.thumbPx,
        );
        const url = res[localPath];
        if (!url) return null;
        const file = url.replace(/^file:\/\/\//, '').replace(/\//g, path.sep);
        const ext = path.extname(file).toLowerCase();
        const mime =
          ext === '.jpg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
        return { file, mime };
      },
    });
    try {
      const { port } = await srv.start();
      linkServer = srv;
      linkServerStatus = { running: true, port, error: '' };
    } catch (e) {
      linkServerStatus = { running: false, port: 0, error: (e as Error).message || '启动失败' };
    }
    return linkServerStatus;
  });
}

// ---------------- 取消控制器注册表 ----------------

const activeSearches = new Map<string, AbortController>();
const activeTransfers = new Map<string, AbortController>();
const activeArchives = new Map<string, { cancel(): void }>();
let activeScanController: AbortController | null = null;

// ---------------- 注册全量 IPC 处理器 ----------------

function registerIpc() {
  ipcMain.handle('app:getVersion', () => app.getVersion());

  // 设置与主题
  ipcMain.handle('settings:get', () => {
    const s = loadSettings();
    if (!s.deviceId) {
      s.deviceId = ensureDeviceId();
    }
    if (Array.isArray(s.quickAccess)) cachedQuickAccess = s.quickAccess;
    if (s.qaNames && typeof s.qaNames === 'object') cachedQaNames = s.qaNames;
    return s;
  });

  ipcMain.handle('settings:set', (_e, patch: AppSettings) => {
    const merged = { ...loadSettings(), ...patch };
    if (Array.isArray(merged.quickAccess)) cachedQuickAccess = merged.quickAccess;
    if (merged.qaNames && typeof merged.qaNames === 'object') cachedQaNames = merged.qaNames;
    saveSettings(merged);
    if (patch.messageRetention) {
      try {
        getMessageStore().prune(normalizeRetention(merged.messageRetention));
      } catch {}
    }
    return merged;
  });

  ipcMain.handle('theme:get', () => ({
    choice: loadSettings().theme || 'system',
    dark: nativeTheme.shouldUseDarkColors,
  }));

  ipcMain.handle('theme:set', (_e, choice: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = choice;
    const s = loadSettings();
    s.theme = choice;
    saveSettings(s);
    return { choice, dark: nativeTheme.shouldUseDarkColors };
  });

  // 窗口控制
  ipcMain.handle('win:minimize', () => mainWindow?.minimize());
  ipcMain.handle('win:maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('win:close', () => mainWindow?.close());
  ipcMain.handle('win:isMaximized', () => mainWindow?.isMaximized() ?? false);

  // 本机文件系统
  ipcMain.handle('fs:special', () => {
    const out: Record<string, string> = {};
    for (const d of QA_DEFAULT_DEFS) {
      try {
        out[d.key] = app.getPath(d.key);
      } catch {}
    }
    return out;
  });

  ipcMain.handle('fs:drives', async () => {
    const roots = listDrives();
    const meta = await getDriveMeta(roots);
    const results = [];
    for (const root of roots) {
      const letter = root.slice(0, 2).toUpperCase();
      const m = meta[letter] || { label: '', type: 3 };
      let free = 0;
      let total = 0;
      try {
        const st = await fsp.statfs(root);
        total = Number(st.blocks) * Number(st.bsize);
        free = Number(st.bavail !== undefined ? st.bavail : st.bfree) * Number(st.bsize);
      } catch {}
      results.push({
        path: root,
        letter,
        label: m.label,
        displayName: driveDisplayName(m),
        type: m.type,
        unc: m.unc || '',
        free: Number.isFinite(free) ? free : 0,
        total: Number.isFinite(total) ? total : 0,
      });
    }
    return results;
  });

  ipcMain.handle('fs:list', async (_e, dir: string) => {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    const items = await Promise.all(
      dirents.map(async (ent) => {
        const full = path.join(dir, ent.name);
        let st: fs.Stats | null = null;
        try {
          st = await fsp.stat(full);
        } catch {}
        const isDirectory = ent.isDirectory() || (st ? st.isDirectory() : false);
        const icon = await iconFor(full, isDirectory);
        return {
          name: ent.name,
          path: full,
          isDirectory,
          size: isDirectory ? 0 : st ? st.size : 0,
          mtime: st ? st.mtimeMs : 0,
          extension: isDirectory ? '' : path.extname(ent.name).toLowerCase(),
          icon,
        };
      }),
    );
    return items;
  });

  ipcMain.handle('fs:exists', (_e, p: string) => fs.existsSync(p));
  ipcMain.handle('fs:parent', (_e, p: string) => {
    const parent = path.dirname(p);
    return parent === p ? '' : parent;
  });
  ipcMain.handle('fs:open', (_e, p: string) => shell.openPath(p));
  ipcMain.handle('fs:showInFolder', (_e, p: string) => {
    shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle('fs:mkdir', async (_e, dir: string, name: string) => {
    const target = path.join(dir, name);
    await fsp.mkdir(target, { recursive: true });
    return target;
  });
  ipcMain.handle('fs:newTextFile', async (_e, dir: string) => {
    let candidate = '新建文本文档.txt';
    let n = 2;
    while (fs.existsSync(path.join(dir, candidate))) {
      candidate = nextName('新建文本文档.txt', n++, false);
    }
    const full = path.join(dir, candidate);
    await fsp.writeFile(full, Buffer.alloc(0));
    return full;
  });
  ipcMain.handle(
    'fs:newFileFromTemplate',
    async (_e, dir: string, name: string, templateKey: string) => {
      let candidate = name;
      let n = 2;
      while (fs.existsSync(path.join(dir, candidate))) {
        candidate = nextName(name, n++, false);
      }
      const full = path.join(dir, candidate);
      await fsp.writeFile(full, getTemplateBuffer(templateKey));
      return full;
    },
  );
  ipcMain.handle('fs:rename', async (_e, oldPath: string, newName: string) => {
    const target = path.join(path.dirname(oldPath), newName);
    await fsp.rename(oldPath, target);
    return target;
  });
  ipcMain.handle('fs:trash', async (_e, paths: string[]) => {
    for (const p of paths) await shell.trashItem(p);
    return true;
  });
  ipcMain.handle('fs:delete', async (_e, paths: string[]) => {
    for (const p of paths) await fsp.rm(p, { recursive: true, force: true });
    return true;
  });
  ipcMain.handle('fs:copy', async (_e, sources: string[], destDir: string) => {
    for (const src of sources) {
      const base = path.basename(src);
      const st = await fsp.stat(src);
      let candidate = base;
      let n = 2;
      while (fs.existsSync(path.join(destDir, candidate))) {
        candidate = nextName(base, n++, st.isDirectory());
      }
      await fsp.cp(src, path.join(destDir, candidate), { recursive: true });
    }
    return true;
  });
  ipcMain.handle('fs:move', async (_e, sources: string[], destDir: string) => {
    for (const src of sources) {
      const base = path.basename(src);
      const st = await fsp.stat(src);
      let candidate = base;
      let n = 2;
      if (path.resolve(path.dirname(src)) === path.resolve(destDir)) continue;
      while (fs.existsSync(path.join(destDir, candidate))) {
        candidate = nextName(base, n++, st.isDirectory());
      }
      const dst = path.join(destDir, candidate);
      try {
        await fsp.rename(src, dst);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
          await fsp.cp(src, dst, { recursive: true });
          await fsp.rm(src, { recursive: true, force: true });
        } else {
          throw e;
        }
      }
    }
    return true;
  });
  ipcMain.handle('fs:stat', async (_e, p: string) => {
    const st = await fsp.stat(p);
    return {
      path: p,
      name: path.basename(p),
      isDirectory: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
      ctime: st.ctimeMs,
      birthtime: st.birthtimeMs,
    };
  });
  ipcMain.handle('fs:extProps', (_e, p: string) => getExtendedProps(p));
  ipcMain.handle('fs:shellMenu', (_e, paths: string[], x: number, y: number) =>
    runShellMenu(paths, x, y),
  );
  ipcMain.handle('fs:openAs', (_e, p: string) => openWithDialog(p));
  ipcMain.handle(
    'fs:thumbs',
    (_e, items: Array<{ path: string; mtime: number; size: number }>) => fetchThumbnails(items),
  );
  ipcMain.handle('fs:search', async (_e, req: { id: string; dir: string; query: string }) => {
    const ctrl = new AbortController();
    activeSearches.set(req.id, ctrl);
    try {
      return await searchLocal({ dir: req.dir, query: req.query, signal: ctrl.signal });
    } finally {
      activeSearches.delete(req.id);
    }
  });
  ipcMain.handle('fs:searchCancel', (_e, id: string) => {
    activeSearches.get(id)?.abort();
    activeSearches.delete(id);
    return true;
  });

  // 系统剪贴板互通
  ipcMain.handle('clip:writeFiles', (_e, mode: 'copy' | 'cut', paths: string[]) =>
    clipWriteFiles(mode, paths),
  );
  ipcMain.handle('clip:readFiles', () => clipReadFiles());
  ipcMain.handle('clip:clearIfMatch', (_e, paths: string[]) => clipClearIfMatch(paths));

  // 自动刷新监听
  ipcMain.handle('watch:set', async (_e, paneId: string, dirPath: string) => {
    if (!dirPath) {
      folderWatcher.clear(paneId);
      return 'none';
    }
    if (await isNetworkPath(dirPath)) {
      folderWatcher.clear(paneId);
      return 'poll';
    }
    return folderWatcher.watch(paneId, dirPath);
  });
  ipcMain.handle('watch:clear', (_e, paneId: string) => {
    folderWatcher.clear(paneId);
    return true;
  });

  // 压缩包查看、压缩、解压
  ipcMain.handle(
    'archive:list',
    async (_e, req: { archivePath: string; password?: string }) => {
      const exe = findBundledExe('7za.exe');
      if (!exe) return { ok: false, code: 'NOT_FOUND', error: '7za.exe 未找到' };
      return listArchiveEntries({
        exePath: exe,
        archivePath: req.archivePath,
        password: req.password,
      });
    },
  );
  ipcMain.handle(
    'archive:compress',
    async (
      _e,
      req: {
        id: string;
        format: 'zip' | '7z';
        level: string;
        password?: string;
        destDir: string;
        archiveName: string;
        sources: string[];
      },
    ) => {
      const exe = findBundledExe('7za.exe');
      if (!exe) return { ok: false, error: '7za.exe 未找到' };
      if (!validArchiveBaseName(req.archiveName)) return { ok: false, error: '压缩包名称不合法' };
      const outPath = path.join(req.destDir, `${req.archiveName}.${req.format}`);
      const args = buildCompressArgs({
        format: req.format,
        level: req.level,
        password: req.password,
        outPath,
        sources: req.sources,
      });
      const job = runSevenZip({
        exePath: exe,
        args,
        cwd: req.destDir,
        onProgress: (p) =>
          mainWindow?.webContents.send('archive:progress', { id: req.id, ...p }),
      });
      activeArchives.set(req.id, job);
      try {
        const res = await job.promise;
        if (res.cancelled) return { ok: false, cancelled: true };
        if (res.code === 0 || res.code === 1) return { ok: true, outPath };
        const err = classifyError({ code: res.code ?? -1, stderr: res.stderr });
        return { ok: false, code: err.code, error: err.message };
      } finally {
        activeArchives.delete(req.id);
      }
    },
  );
  ipcMain.handle(
    'archive:extract',
    async (
      _e,
      req: {
        id: string;
        archivePath: string;
        outDir: string;
        password?: string;
        entries?: string[];
      },
    ) => {
      const exe = findBundledExe('7za.exe');
      if (!exe) return { ok: false, error: '7za.exe 未找到' };
      fs.mkdirSync(req.outDir, { recursive: true });
      const args = buildExtractArgs({
        archivePath: req.archivePath,
        outDir: req.outDir,
        password: req.password,
        entries: req.entries,
      });
      const job = runSevenZip({
        exePath: exe,
        args,
        onProgress: (p) =>
          mainWindow?.webContents.send('archive:progress', { id: req.id, ...p }),
      });
      activeArchives.set(req.id, job);
      try {
        const res = await job.promise;
        if (res.cancelled) return { ok: false, cancelled: true };
        if (res.code === 0 || res.code === 1) return { ok: true, outDir: req.outDir };
        const err = classifyError({ code: res.code ?? -1, stderr: res.stderr });
        return { ok: false, code: err.code, error: err.message };
      } finally {
        activeArchives.delete(req.id);
      }
    },
  );
  ipcMain.handle('archive:cancel', (_e, id: string) => {
    activeArchives.get(id)?.cancel();
    activeArchives.delete(id);
    return true;
  });

  // 内置互联协议客户端与服务端控制
  ipcMain.handle('link:serverStatus', () => linkServerStatus);
  ipcMain.handle('link:applyServer', () => applyLinkServerSettings());
  ipcMain.handle('link:localAddrs', () => localLanAddrs());
  ipcMain.handle('link:scan', async () => {
    activeScanController?.abort();
    activeScanController = new AbortController();
    try {
      return await scanLinkDevices({ signal: activeScanController.signal });
    } finally {
      activeScanController = null;
    }
  });
  ipcMain.handle('link:cancelScan', () => {
    activeScanController?.abort();
    activeScanController = null;
    return true;
  });
  ipcMain.handle('link:test', (_e, conn: LinkConnection) => createLinkClient(conn).info());
  ipcMain.handle('link:roots', (_e, conn: LinkConnection) => createLinkClient(conn).roots());
  ipcMain.handle('link:quickAccess', async (_e, conn: LinkConnection) => {
    try {
      return await createLinkClient(conn).quickAccess();
    } catch {
      return { ok: true, items: [] };
    }
  });
  ipcMain.handle('link:list', (_e, conn: LinkConnection, p: string) =>
    createLinkClient(conn).list(p),
  );
  ipcMain.handle('link:stat', (_e, conn: LinkConnection, p: string) =>
    createLinkClient(conn).stat(p),
  );
  ipcMain.handle('link:mkdir', (_e, conn: LinkConnection, dir: string, name: string) =>
    createLinkClient(conn).mkdir(wireJoin(dir, name)),
  );
  ipcMain.handle('link:uploadEmpty', async (_e, conn: LinkConnection, dir: string) => {
    const client = createLinkClient(conn);
    let candidate = '新建文本文档.txt';
    let n = 2;
    while (await client.exists(wireJoin(dir, candidate))) {
      candidate = nextName('新建文本文档.txt', n++, false);
    }
    const target = wireJoin(dir, candidate);
    await client.uploadBuffer(target, Buffer.alloc(0));
    return target;
  });
  ipcMain.handle(
    'link:uploadTemplate',
    async (_e, conn: LinkConnection, dir: string, name: string, templateKey: string) => {
      const client = createLinkClient(conn);
      let candidate = name;
      let n = 2;
      while (await client.exists(wireJoin(dir, candidate))) {
        candidate = nextName(name, n++, false);
      }
      const target = wireJoin(dir, candidate);
      await client.uploadBuffer(target, getTemplateBuffer(templateKey));
      return target;
    },
  );
  ipcMain.handle('link:rename', (_e, conn: LinkConnection, p: string, newName: string) =>
    createLinkClient(conn).rename(p, newName),
  );
  ipcMain.handle('link:delete', async (_e, conn: LinkConnection, paths: string[]) => {
    const client = createLinkClient(conn);
    for (const p of paths) await client.deleteOne(p);
    return true;
  });
  ipcMain.handle(
    'link:thumbs',
    async (
      _e,
      conn: LinkConnection,
      items: Array<{ path: string; mtime: number; size: number }>,
    ) => {
      const out: Record<string, string> = {};
      const client = createLinkClient(conn);
      for (const it of items.slice(0, 40)) {
        const key = crypto
          .createHash('sha256')
          .update(`remote|${conn.host}:${conn.port}|${it.path}|${it.mtime}|${it.size}`)
          .digest('hex');
        const hit = thumbCacheFindByKey(key);
        if (hit) {
          out[it.path] = thumbFileUrl(hit);
          continue;
        }
        try {
          const { buffer, contentType } = await client.thumbnail(it.path, 256);
          const ext = extForThumbBytes(contentType, buffer);
          const dest = path.join(thumbDir(), key + ext);
          fs.writeFileSync(dest, buffer);
          out[it.path] = thumbFileUrl(dest);
        } catch {}
      }
      pruneThumbCache();
      return out;
    },
  );

  // 打开远程文件：音视频优先流播代理 + 按扩展名 Windows 默认程序打开；其他下载到临时目录打开
  async function openRemoteFile(conn: LinkConnection, wirePath: string, openAsMode: boolean) {
    const baseName = wirePath.replace(/\/+$/, '').split('/').pop() || 'file';
    const ext = path.extname(baseName).toLowerCase();
    const tmpDir = path.join(app.getPath('temp'), 'ShizukuExplorer-remote');
    fs.mkdirSync(tmpDir, { recursive: true });

    if (isMediaPath(wirePath) && (await probeStream(conn, wirePath))) {
      const url = await mediaProxy.streamUrl(conn, wirePath);
      const m3uPath = path.join(tmpDir, `${crypto.randomUUID()}-${baseName}.m3u`);
      fs.writeFileSync(m3uPath, buildPlaylistContent(baseName, url), 'utf8');
      if (openAsMode) return openWithDialog(m3uPath);
      const openedByDefault = await openWithDefaultApp(ext, m3uPath);
      if (openedByDefault) return { ok: true, mode: 'stream-default-app' };
      const errMsg = await shell.openPath(m3uPath);
      return errMsg ? { ok: false, error: errMsg } : { ok: true, mode: 'stream-m3u' };
    }

    const localTmp = path.join(tmpDir, `${crypto.randomUUID()}-${baseName}`);
    await createLinkClient(conn).downloadToFile(wirePath, localTmp);
    if (openAsMode) return openWithDialog(localTmp);
    const errMsg = await shell.openPath(localTmp);
    return errMsg ? { ok: false, error: errMsg } : { ok: true, mode: 'download' };
  }

  ipcMain.handle('link:open', (_e, conn: LinkConnection, wirePath: string) =>
    openRemoteFile(conn, wirePath, false),
  );
  ipcMain.handle('link:openAs', (_e, conn: LinkConnection, wirePath: string) =>
    openRemoteFile(conn, wirePath, true),
  );

  // 跨端文件传输（支持上传、下载、同设备复制/移动、跨设备流式直传）
  ipcMain.handle(
    'link:transfer',
    async (
      _e,
      req: {
        id: string;
        mode: 'copy' | 'cut';
        srcKind: 'local' | 'remote';
        srcConn?: LinkConnection;
        sources: Array<{ path: string; name: string; isDirectory: boolean; size: number }>;
        dstKind: 'local' | 'remote';
        dstConn?: LinkConnection;
        destDir: string;
      },
    ) => {
      const ctrl = new AbortController();
      activeTransfers.set(req.id, ctrl);
      const tracker = createRateTracker();
      let doneBytes = 0;
      const totalBytes = req.sources.reduce((acc, s) => acc + (s.size || 0), 0);
      let doneCount = 0;

      const emit = (currentFile: string, extraBytes = 0) => {
        const cur = doneBytes + extraBytes;
        mainWindow?.webContents.send('link:transfer-progress', {
          id: req.id,
          currentFile,
          doneBytes: cur,
          totalBytes,
          speedBytesPerSec: tracker.sample(cur),
          doneCount,
          totalCount: req.sources.length,
        });
      };

      try {
        // 同设备远程操作
        if (
          req.srcKind === 'remote' &&
          req.dstKind === 'remote' &&
          req.srcConn &&
          req.dstConn &&
          req.srcConn.host === req.dstConn.host &&
          req.srcConn.port === req.dstConn.port
        ) {
          const client = createLinkClient(req.srcConn);
          for (const src of req.sources) {
            emit(src.name);
            if (req.mode === 'cut') await client.move(src.path, req.destDir, ctrl.signal);
            else await client.copy(src.path, req.destDir, ctrl.signal);
            doneBytes += src.size || 0;
            doneCount++;
            emit(src.name);
          }
          return { ok: true };
        }

        // 本机 -> 远程上传（含递归目录）
        if (req.srcKind === 'local' && req.dstKind === 'remote' && req.dstConn) {
          const dstClient = createLinkClient(req.dstConn);
          const uploadRecursive = async (localPath: string, remoteParent: string) => {
            const st = await fsp.stat(localPath);
            const name = path.basename(localPath);
            const remoteTarget = wireJoin(remoteParent, name);
            if (st.isDirectory()) {
              await dstClient.mkdir(remoteTarget, ctrl.signal);
              for (const ent of await fsp.readdir(localPath)) {
                await uploadRecursive(path.join(localPath, ent), remoteTarget);
              }
            } else {
              await dstClient.uploadFile(localPath, remoteTarget, {
                signal: ctrl.signal,
                onProgress: (sent) => emit(name, sent),
              });
              doneBytes += st.size;
            }
          };
          for (const src of req.sources) {
            await uploadRecursive(src.path, req.destDir);
            if (req.mode === 'cut') await fsp.rm(src.path, { recursive: true, force: true });
            doneCount++;
            emit(src.name);
          }
          return { ok: true };
        }

        // 远程 -> 本机下载（含递归目录）
        if (req.srcKind === 'remote' && req.dstKind === 'local' && req.srcConn) {
          const srcClient = createLinkClient(req.srcConn);
          const downloadRecursive = async (
            remotePath: string,
            name: string,
            isDir: boolean,
            localParent: string,
          ) => {
            const localTarget = path.join(localParent, name);
            if (isDir) {
              fs.mkdirSync(localTarget, { recursive: true });
              const listed = await srcClient.list(remotePath, ctrl.signal);
              for (const child of listed.items) {
                await downloadRecursive(child.path, child.name, child.isDirectory, localTarget);
              }
            } else {
              const res = await srcClient.downloadToFile(remotePath, localTarget, {
                signal: ctrl.signal,
                onProgress: (written) => emit(name, written),
              });
              doneBytes += res.size;
            }
          };
          for (const src of req.sources) {
            await downloadRecursive(src.path, src.name, src.isDirectory, req.destDir);
            if (req.mode === 'cut') await srcClient.deleteOne(src.path, ctrl.signal);
            doneCount++;
            emit(src.name);
          }
          return { ok: true };
        }

        // 远程 A -> 远程 B 流式中转
        if (req.srcKind === 'remote' && req.dstKind === 'remote' && req.srcConn && req.dstConn) {
          const srcClient = createLinkClient(req.srcConn);
          const dstClient = createLinkClient(req.dstConn);
          const relayRecursive = async (
            remotePath: string,
            name: string,
            isDir: boolean,
            dstParent: string,
          ) => {
            const dstTarget = wireJoin(dstParent, name);
            if (isDir) {
              await dstClient.mkdir(dstTarget, ctrl.signal);
              const listed = await srcClient.list(remotePath, ctrl.signal);
              for (const child of listed.items) {
                await relayRecursive(child.path, child.name, child.isDirectory, dstTarget);
              }
            } else {
              const { stream, size } = await srcClient.downloadStream(remotePath, {
                signal: ctrl.signal,
              });
              await dstClient.uploadStream(stream, dstTarget, { signal: ctrl.signal, size });
              doneBytes += size;
            }
          };
          for (const src of req.sources) {
            emit(src.name);
            await relayRecursive(src.path, src.name, src.isDirectory, req.destDir);
            if (req.mode === 'cut') await srcClient.deleteOne(src.path, ctrl.signal);
            doneCount++;
            emit(src.name);
          }
          return { ok: true };
        }

        return { ok: false, error: '不支持的传输组合' };
      } finally {
        activeTransfers.delete(req.id);
      }
    },
  );
  ipcMain.handle('link:cancelTransfer', (_e, id: string) => {
    activeTransfers.get(id)?.abort();
    activeTransfers.delete(id);
    return true;
  });

  // 互联消息与附件
  ipcMain.handle('msg:list', (_e, deviceId: string) => getMessageStore().list(deviceId));
  ipcMain.handle('msg:markRead', (_e, deviceId: string) => getMessageStore().markRead(deviceId));
  ipcMain.handle('msg:unread', () => getMessageStore().unreadCounts());
  ipcMain.handle('msg:pickAttachment', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const localPath = res.filePaths[0];
    const st = await fsp.stat(localPath);
    const name = path.basename(localPath);
    const ext = path.extname(name).toLowerCase();
    const mime =
      ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)
        ? `image/${ext.slice(1).replace('jpg', 'jpeg')}`
        : ['.mp4', '.mkv', '.webm', '.mov'].includes(ext)
          ? 'video/mp4'
          : ['.mp3', '.flac', '.wav', '.m4a'].includes(ext)
            ? 'audio/mpeg'
            : 'application/octet-stream';
    return { localPath, name, size: st.size, mime };
  });
  ipcMain.handle(
    'msg:send',
    async (
      _e,
      conn: LinkConnection,
      deviceId: string,
      text: string,
      attachment?: { localPath: string; name: string; size: number; mime: string } | null,
    ) => {
      const client = createLinkClient(conn);
      const settings = loadSettings();
      const myName = settings.linkServer?.name || os.hostname();
      const myId = ensureDeviceId();
      const cleanText = String(text || '').slice(0, MAX_TEXT_LEN);
      let attPayload: { fileId: string; name: string; size: number; mime: string } | undefined;

      if (attachment) {
        const up = await client.uploadMessageFile(attachment.localPath, {
          onProgress: (sent, total) =>
            mainWindow?.webContents.send('msg:send-progress', { deviceId, sent, total }),
        });
        attPayload = {
          fileId: up.fileId,
          name: attachment.name,
          size: attachment.size,
          mime: attachment.mime,
        };
      }

      const now = Date.now();
      await client.sendMessage({
        text: cleanText,
        from: myName,
        fromId: myId,
        time: now,
        ...(attPayload ? { attachment: attPayload } : {}),
      });

      if (attPayload && attachment) {
        try {
          getMessageStore().copyIntoStore(deviceId, attPayload.fileId, attachment.localPath);
        } catch {}
      }
      return getMessageStore().add({
        deviceId,
        dir: 'out',
        text: cleanText,
        from: myName,
        fromId: myId,
        time: now,
        attachment: attPayload || null,
        read: true,
      });
    },
  );
  ipcMain.handle('msg:openAttachment', async (_e, deviceId: string, fileId: string) => {
    const p = getMessageStore().attachmentPath(deviceId, fileId);
    if (!fs.existsSync(p)) return { ok: false, error: '附件文件不存在' };
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  });
}

// ---------------- 窗口创建与生命周期 ----------------

function createWindow() {
  const s = loadSettings();
  if (s.theme) nativeTheme.themeSource = s.theme;

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 920,
    minHeight: 600,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191a1c' : '#f3f3f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // 允许加载本地 file:/// 缩略图缓存
    },
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('win:maximize-changed', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('win:maximize-changed', false));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

nativeTheme.on('updated', () => {
  mainWindow?.webContents.send('theme:updated', nativeTheme.shouldUseDarkColors);
});

app.whenReady().then(async () => {
  ensureDeviceId();
  const s = loadSettings();
  if (Array.isArray(s.quickAccess)) cachedQuickAccess = s.quickAccess;
  if (s.qaNames && typeof s.qaNames === 'object') cachedQaNames = s.qaNames;

  registerIpc();
  createWindow();

  try {
    getMessageStore().prune(normalizeRetention(s.messageRetention));
  } catch {}
  setInterval(() => {
    try {
      getMessageStore().prune(normalizeRetention(loadSettings().messageRetention));
    } catch {}
  }, 60 * 60 * 1000);

  await applyLinkServerSettings();
});

app.on('before-quit', async () => {
  folderWatcher.clearAll();
  await mediaProxy.stop();
  if (linkServer) {
    try {
      await linkServer.stop();
    } catch {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
