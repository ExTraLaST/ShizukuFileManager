/**
 * Shizuku 互联服务端（电脑版内置模块）
 * 严格遵循 docs/PROTOCOL.md（Shizuku 互联协议 v1）
 * 纯 Node.js 实现，不依赖 Electron，可直接脱离桌面环境进行自动化测试。
 */
import http from 'http';
import dgram from 'dgram';
import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import type { MessageRecord, MessageStore } from './message-store';

export const PROTOCOL_VERSION = 1;
export const DISCOVERY_PORT = 8897;
export const DISCOVERY_REQUEST = 'SHIZUKU-LINK-DISCOVER';
export const DISCOVERY_RESPONSE_PREFIX = 'SHIZUKU-LINK-HERE ';
export const MAX_JSON_BODY = 1024 * 1024; // 1MB
export const MAX_MESSAGE_FILE = 2 * 1024 * 1024 * 1024; // 2GB

/** 支持生成远程缩略图的扩展名（图片 + 视频） */
export const THUMBABLE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.avif',
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m2ts', '.ts', '.rmvb',
]);

export interface DriveOverride {
  letter: string;
  localRoot: string;
  label?: string;
}

export interface QuickAccessInput {
  path: string;
  name?: string;
  isFile?: boolean;
}

export interface ThumbnailResult {
  file: string;
  mime?: string;
}

export interface LinkServerOptions {
  port?: number;
  password: string;
  name?: string;
  deviceId?: string | null;
  drives?: DriveOverride[];
  getQuickAccess?: () => QuickAccessInput[];
  quickAccess?: QuickAccessInput[];
  messageStore?: MessageStore | null;
  onMessage?: (record: MessageRecord) => void;
  generateThumbnail?: (
    localPath: string,
    meta: { mtime: number; size: number; thumbPx: number },
  ) => Promise<ThumbnailResult | null>;
  enableDiscovery?: boolean;
}

export interface NormalizedWirePath {
  wire: string;
  letter: string;
  parts: string[];
  isRoot: boolean;
}

/** 规范化并校验 Windows wire 路径（如 C:/Users/demo） */
export function normalizeWirePath(raw: unknown): NormalizedWirePath | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { error: '路径不合法' };
  if (raw.includes('\0') || raw.includes('\\')) return { error: '路径不合法' };
  const segs = raw.split('/');
  if (segs.some((s) => s === '..')) return { error: '路径不合法' };
  const p = raw.replace(/\/+$/, '');
  if (p === '') return { error: '路径不合法' };
  const m = /^([A-Za-z]):(.*)$/.exec(p);
  if (!m) return { error: '路径不合法' };
  const letter = m[1].toUpperCase();
  const rest = m[2];
  if (rest !== '' && !rest.startsWith('/')) return { error: '路径不合法' };
  const parts = rest.split('/').filter((s) => s.length > 0);
  if (parts.some((s) => s === '..')) return { error: '路径不合法' };
  const wire = parts.length === 0 ? `${letter}:/` : `${letter}:/${parts.join('/')}`;
  return { wire, letter, parts, isRoot: parts.length === 0 };
}

export function wireJoin(dirWire: string, name: string): string {
  return dirWire.endsWith('/') ? `${dirWire}${name}` : `${dirWire}/${name}`;
}

export function wireParent(wire: string): string | null {
  const n = normalizeWirePath(wire);
  if ('error' in n || n.isRoot) return null;
  const parts = n.parts.slice(0, -1);
  return parts.length === 0 ? `${n.letter}:/` : `${n.letter}:/${parts.join('/')}`;
}

export function wireBaseName(wire: string): string {
  const n = normalizeWirePath(wire);
  if ('error' in n || n.isRoot) return '';
  return n.parts[n.parts.length - 1];
}

/** 解析 HTTP Range 请求头，返回闭区间 { start, end }，非法/越界返回 null */
export function parseRangeHeader(
  rangeHeader: unknown,
  total: number,
): { start: number; end: number } | null {
  if (typeof rangeHeader !== 'string' || total <= 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;
  let start: number;
  let end: number;
  if (startStr === '') {
    const suffix = Number(endStr);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(startStr);
    if (!Number.isFinite(start) || start < 0) return null;
    if (endStr === '') {
      end = total - 1;
    } else {
      end = Number(endStr);
      if (!Number.isFinite(end) || end < start) return null;
    }
    if (start >= total) return null;
    if (end >= total) end = total - 1;
  }
  return { start, end };
}

/** 将快速访问列表转换为协议格式（仅保留文件夹） */
export function quickAccessToWire(items: unknown): Array<{ name: string; path: string }> {
  if (!Array.isArray(items)) return [];
  const out: Array<{ name: string; path: string }> = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || typeof (it as QuickAccessInput).path !== 'string') continue;
    const item = it as QuickAccessInput;
    if (item.isFile === true) continue;
    const wire = item.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const norm = normalizeWirePath(wire);
    if ('error' in norm) continue;
    const name =
      typeof item.name === 'string' && item.name
        ? item.name
        : norm.isRoot
          ? `${norm.letter}:`
          : norm.parts[norm.parts.length - 1];
    out.push({ name, path: norm.wire });
  }
  return out;
}

/** 自动重名递增规则：a.txt -> a (2).txt */
export function nextName(name: string, n: number, isDir: boolean): string {
  if (isDir) return `${name} (${n})`;
  const dot = name.lastIndexOf('.');
  if (dot > 0) return `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return `${name} (${n})`;
}

/** Windows 文件名合法性校验 */
export function isValidFileName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\/\\:*?"<>|\x00-\x1f]/.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  return true;
}

/** 校验本地路径是否仍在根目录范围内（处理 D:\ 末尾自带反斜杠的情况） */
export function isWithinRoot(rootResolved: string, local: string, sep: string = path.sep): boolean {
  if (local === rootResolved) return true;
  const rootWithSep = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  return local.startsWith(rootWithSep);
}

/** 构造 UDP 自动发现回应报文 */
export function buildDiscoveryResponse(name: string, port: number, deviceId?: string | null): string {
  return (
    DISCOVERY_RESPONSE_PREFIX +
    JSON.stringify({
      name,
      type: 'pc',
      port,
      version: PROTOCOL_VERSION,
      ...(deviceId ? { id: deviceId } : {}),
    })
  );
}

function probeDrives(): Array<{ letter: string; localRoot: string; label: string }> {
  const drives: Array<{ letter: string; localRoot: string; label: string }> = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (fs.existsSync(root)) drives.push({ letter, localRoot: root, label: '' });
    } catch {
      // 忽略无权限或未就绪盘符
    }
  }
  return drives;
}

function getVolumeLabels(): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({});
      return;
    }
    execFile(
      'wmic',
      ['logicaldisk', 'get', 'DeviceID,VolumeName', '/format:csv'],
      { timeout: 8000 },
      async (err, stdout) => {
        const map: Record<string, string> = {};
        if (!err && stdout) {
          for (const line of stdout.split(/\r?\n/)) {
            const parts = line.split(',');
            if (parts.length >= 3 && /^[A-Z]:$/.test((parts[1] || '').trim())) {
              map[parts[1].trim()[0]] = (parts[2] || '').trim();
            }
          }
        }
        if (Object.keys(map).length > 0) {
          resolve(map);
          return;
        }
        const letters: string[] = [];
        for (let code = 65; code <= 90; code++) {
          const ch = String.fromCharCode(code);
          try {
            if (fs.existsSync(`${ch}:\\`)) letters.push(ch);
          } catch {}
        }
        await Promise.all(
          letters.map(
            (ch) =>
              new Promise<void>((resVol) => {
                execFile(
                  'cmd',
                  ['/c', `chcp 65001 >nul & vol ${ch}:`],
                  { timeout: 5000 },
                  (e2, out2) => {
                    if (!e2 && out2) {
                      const firstLine = out2.split(/\r?\n/).find((l) => l.trim());
                      const m = firstLine && firstLine.match(/(?:is|是)\s+(.+)$/);
                      if (m && m[1] && !/has no label|没有卷标/i.test(m[1])) {
                        map[ch] = m[1].trim();
                      }
                    }
                    resVol();
                  },
                );
              }),
          ),
        );
        resolve(map);
      },
    );
  });
}

async function driveUsage(localRoot: string): Promise<{ free: number; total: number }> {
  try {
    const st = await fsp.statfs(localRoot);
    const total = Number(st.blocks) * Number(st.bsize);
    const free = Number(st.bavail !== undefined ? st.bavail : st.bfree) * Number(st.bsize);
    return {
      free: Number.isFinite(free) ? free : 0,
      total: Number.isFinite(total) ? total : 0,
    };
  } catch {
    return { free: 0, total: 0 };
  }
}

function isSafeFileId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v) &&
    !v.includes('..')
  );
}

export interface LinkServerInstance {
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getPort(): number;
}

/** 创建电脑版内置互联服务端 */
export function createLinkServer(options: LinkServerOptions): LinkServerInstance {
  const password = options.password || '';
  const port = Number(options.port ?? 8898);
  const name = options.name || os.hostname();
  const deviceId =
    typeof options.deviceId === 'string' && options.deviceId ? options.deviceId : null;
  const drivesOverride = Array.isArray(options.drives) ? options.drives : null;
  const getQuickAccess =
    typeof options.getQuickAccess === 'function'
      ? options.getQuickAccess
      : Array.isArray(options.quickAccess)
        ? () => options.quickAccess!
        : () => [];
  const messageStore = options.messageStore || null;
  const onMessage = typeof options.onMessage === 'function' ? options.onMessage : null;
  const generateThumbnail =
    typeof options.generateThumbnail === 'function' ? options.generateThumbnail : null;
  const enableDiscovery = options.enableDiscovery !== false;

  let server: http.Server | null = null;
  let udpSocket: dgram.Socket | null = null;
  let running = false;
  let actualPort = port;
  let drives: Array<{ letter: string; localRoot: string; label: string }> = [];
  let labelsLoaded = false;

  async function ensureDrives(): Promise<void> {
    if (drivesOverride) {
      drives = drivesOverride.map((d) => ({
        letter: String(d.letter).toUpperCase().replace(/:$/, ''),
        localRoot: d.localRoot,
        label: d.label || '',
      }));
      return;
    }
    drives = probeDrives();
    if (!labelsLoaded && process.platform === 'win32') {
      labelsLoaded = true;
      const labels = await getVolumeLabels();
      for (const d of drives) d.label = labels[d.letter] || '';
    }
  }

  function driveOf(letter: string) {
    return drives.find((d) => d.letter === letter) || null;
  }

  function toLocal(norm: NormalizedWirePath): string | { outside: true } | null {
    const drive = driveOf(norm.letter);
    if (!drive) return null;
    const rootResolved = path.resolve(drive.localRoot);
    const local =
      norm.parts.length === 0 ? rootResolved : path.resolve(rootResolved, ...norm.parts);
    if (!isWithinRoot(rootResolved, local, path.sep)) {
      return { outside: true };
    }
    return local;
  }

  function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  const fail = (res: http.ServerResponse, status: number, error: string) =>
    sendJson(res, status, { ok: false, error });

  function checkAuth(req: http.IncomingMessage): boolean {
    const token = req.headers['x-shizuku-token'];
    if (typeof token !== 'string') return false;
    const a = crypto.createHash('sha256').update(token).digest();
    const b = crypto.createHash('sha256').update(password).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_JSON_BODY && !done) {
          done = true;
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new Error('请求体不是合法 JSON'));
        }
      });
      req.on('error', (e) => {
        if (!done) {
          done = true;
          reject(e);
        }
      });
    });
  }

  function resolvePathParam(
    res: http.ServerResponse,
    raw: unknown,
  ): { norm: NormalizedWirePath; local: string } | null {
    const norm = normalizeWirePath(raw);
    if ('error' in norm) {
      fail(res, 400, '路径不合法');
      return null;
    }
    const local = toLocal(norm);
    if (local === null) {
      fail(res, 404, '文件或目录不存在');
      return null;
    }
    if (typeof local !== 'string') {
      fail(res, 400, '路径不合法');
      return null;
    }
    return { norm, local };
  }

  async function statOrNull(local: string): Promise<fs.Stats | null> {
    try {
      return await fsp.stat(local);
    } catch {
      return null;
    }
  }

  async function uniqueTarget(
    destDirLocal: string,
    destDirWire: string,
    itemName: string,
    isDir: boolean,
  ): Promise<{ local: string; wire: string; name: string }> {
    let candidate = itemName;
    let n = 2;
    for (;;) {
      const local = path.join(destDirLocal, candidate);
      if (!(await statOrNull(local))) {
        return { local, wire: wireJoin(destDirWire, candidate), name: candidate };
      }
      candidate = nextName(itemName, n++, isDir);
    }
  }

  // ---------------- 15 个 REST 接口处理器 ----------------

  async function handleInfo(_req: http.IncomingMessage, res: http.ServerResponse) {
    sendJson(res, 200, {
      ok: true,
      name,
      type: 'pc',
      version: PROTOCOL_VERSION,
      ...(deviceId ? { id: deviceId } : {}),
    });
  }

  async function handleRoots(_req: http.IncomingMessage, res: http.ServerResponse) {
    await ensureDrives();
    const roots = [];
    for (const d of drives) {
      const usage = await driveUsage(d.localRoot);
      roots.push({
        name: d.label ? `${d.label} (${d.letter}:)` : `${d.letter}:`,
        path: `${d.letter}:/`,
        free: usage.free,
        total: usage.total,
      });
    }
    sendJson(res, 200, { ok: true, roots });
  }

  async function handleList(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    query: URLSearchParams,
  ) {
    const r = resolvePathParam(res, query.get('path') || '');
    if (!r) return;
    const st = await statOrNull(r.local);
    if (!st) {
      fail(res, 404, '文件或目录不存在');
      return;
    }
    if (!st.isDirectory()) {
      fail(res, 400, '不是文件夹');
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(r.local, { withFileTypes: true });
    } catch (e) {
      fail(res, 500, (e as Error).message || '读取目录失败');
      return;
    }
    const items = [];
    for (const ent of dirents) {
      const full = path.join(r.local, ent.name);
      let st2: fs.Stats | null = null;
      try {
        st2 = await fsp.stat(full);
      } catch {}
      const isDir = ent.isDirectory() || (st2 ? st2.isDirectory() : false);
      items.push({
        name: ent.name,
        path: wireJoin(r.norm.wire, ent.name),
        isDirectory: isDir,
        size: isDir ? 0 : st2 ? st2.size : 0,
        modified: st2 ? Math.floor(st2.mtimeMs) : 0,
      });
    }
    sendJson(res, 200, { ok: true, items });
  }

  async function handleStat(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    query: URLSearchParams,
  ) {
    const r = resolvePathParam(res, query.get('path') || '');
    if (!r) return;
    const st = await statOrNull(r.local);
    if (!st) {
      sendJson(res, 200, { ok: true, exists: false, isDirectory: false, size: 0, modified: 0 });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      exists: true,
      isDirectory: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      modified: Math.floor(st.mtimeMs),
    });
  }

  async function handleDownload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: URLSearchParams,
  ) {
    const r = resolvePathParam(res, query.get('path') || '');
    if (!r) return;
    const st = await statOrNull(r.local);
    if (!st) {
      fail(res, 404, '文件或目录不存在');
      return;
    }
    if (st.isDirectory()) {
      fail(res, 400, '是文件夹，无法下载');
      return;
    }
    const fileName = path.basename(r.local);
    const total = st.size;
    const rangeHeader = req.headers.range;
    if (rangeHeader !== undefined) {
      const range = parseRangeHeader(rangeHeader, total);
      if (!range) {
        res.writeHead(416, {
          'Content-Range': `bytes */${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': 0,
        });
        res.end();
        return;
      }
      const { start, end } = range;
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      });
      const stream = fs.createReadStream(r.local, { start, end });
      stream.on('error', () => {
        try {
          res.destroy();
        } catch {}
      });
      stream.pipe(res);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': total,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    });
    const stream = fs.createReadStream(r.local);
    stream.on('error', () => {
      try {
        res.destroy();
      } catch {}
    });
    stream.pipe(res);
  }

  async function handleThumbnail(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    query: URLSearchParams,
  ) {
    const r = resolvePathParam(res, query.get('path') || '');
    if (!r) return;
    const st = await statOrNull(r.local);
    if (!st || st.isDirectory()) {
      fail(res, 404, '文件不存在');
      return;
    }
    if (!THUMBABLE_EXTS.has(path.extname(r.local).toLowerCase())) {
      fail(res, 404, '不支持缩略图');
      return;
    }
    if (!generateThumbnail) {
      fail(res, 404, '不支持缩略图');
      return;
    }
    let size = parseInt(query.get('size') || '256', 10);
    if (!Number.isFinite(size)) size = 256;
    size = Math.min(512, Math.max(128, size));
    let thumb: ThumbnailResult | null = null;
    try {
      thumb = await generateThumbnail(r.local, { mtime: st.mtimeMs, size: st.size, thumbPx: size });
    } catch {
      thumb = null;
    }
    if (!thumb || !thumb.file) {
      fail(res, 404, '无法生成缩略图');
      return;
    }
    try {
      const data = await fsp.readFile(thumb.file);
      res.writeHead(200, {
        'Content-Type': thumb.mime || 'image/png',
        'Content-Length': data.length,
        'Cache-Control': 'private, max-age=86400',
      });
      res.end(data);
    } catch {
      if (!res.headersSent) fail(res, 404, '无法生成缩略图');
      else {
        try {
          res.destroy();
        } catch {}
      }
    }
  }

  async function handleQuickAccess(_req: http.IncomingMessage, res: http.ServerResponse) {
    let list: QuickAccessInput[] = [];
    try {
      list = getQuickAccess() || [];
    } catch {
      list = [];
    }
    sendJson(res, 200, { ok: true, items: quickAccessToWire(list) });
  }

  async function handleUpload(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    query: URLSearchParams,
  ) {
    const r = resolvePathParam(res, query.get('path') || '');
    if (!r) return;
    if (r.norm.isRoot) {
      fail(res, 400, '路径不合法');
      return;
    }
    const parent = path.dirname(r.local);
    try {
      await fsp.mkdir(parent, { recursive: true });
    } catch (e) {
      fail(res, 500, (e as Error).message || '创建父目录失败');
      return;
    }
    const existing = await statOrNull(r.local);
    if (existing && existing.isDirectory()) {
      fail(res, 400, '目标是文件夹');
      return;
    }
    const partPath = path.join(
      parent,
      `.${path.basename(r.local)}.shizuku-part-${process.pid}-${Date.now()}`,
    );
    const ws = fs.createWriteStream(partPath);
    let written = 0;
    let settled = false;
    const cleanupPartial = async () => {
      try {
        await fsp.unlink(partPath);
      } catch {}
    };
    req.on('data', (c: Buffer) => {
      written += c.length;
    });
    req.on('aborted', async () => {
      if (settled) return;
      settled = true;
      try {
        ws.destroy();
      } catch {}
      await cleanupPartial();
    });
    ws.on('error', async (e) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {}
      await cleanupPartial();
      if (!res.headersSent) fail(res, 500, e.message || '写入文件失败');
    });
    ws.on('finish', async () => {
      if (settled) return;
      settled = true;
      const bakPath = existing
        ? path.join(parent, `.${path.basename(r.local)}.shizuku-bak-${Date.now()}`)
        : null;
      try {
        if (bakPath && (await statOrNull(r.local))) {
          await fsp.rename(r.local, bakPath);
        }
        await fsp.rename(partPath, r.local);
        if (bakPath) {
          try {
            await fsp.unlink(bakPath);
          } catch {}
        }
        sendJson(res, 200, { ok: true, size: written });
      } catch (e) {
        if (bakPath && (await statOrNull(bakPath)) && !(await statOrNull(r.local))) {
          try {
            await fsp.rename(bakPath, r.local);
          } catch {}
        }
        await cleanupPartial();
        if (!res.headersSent) fail(res, 500, (e as Error).message || '保存上传文件失败');
      }
    });
    req.pipe(ws);
  }

  async function handleMkdir(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      fail(res, 400, (e as Error).message);
      return;
    }
    const r = resolvePathParam(res, body.path || '');
    if (!r) return;
    try {
      await fsp.mkdir(r.local, { recursive: true });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') fail(res, 400, '已存在同名文件');
      else fail(res, 500, err.message || '创建目录失败');
    }
  }

  async function handleDelete(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      fail(res, 400, (e as Error).message);
      return;
    }
    const r = resolvePathParam(res, body.path || '');
    if (!r) return;
    if (r.norm.isRoot) {
      fail(res, 400, '根目录不能这样操作');
      return;
    }
    const st = await statOrNull(r.local);
    if (!st) {
      fail(res, 404, '文件或目录不存在');
      return;
    }
    try {
      await fsp.rm(r.local, { recursive: true, force: true });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      fail(res, 500, (e as Error).message || '删除失败');
    }
  }

  async function handleRename(req: http.IncomingMessage, res: http.ServerResponse) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      fail(res, 400, (e as Error).message);
      return;
    }
    const r = resolvePathParam(res, body.path || '');
    if (!r) return;
    if (r.norm.isRoot) {
      fail(res, 400, '根目录不能这样操作');
      return;
    }
    if (!isValidFileName(body.newName)) {
      fail(res, 400, '文件名不合法');
      return;
    }
    const st = await statOrNull(r.local);
    if (!st) {
      fail(res, 404, '文件或目录不存在');
      return;
    }
    const parentWire = wireParent(r.norm.wire);
    if (!parentWire) {
      fail(res, 400, '根目录不能这样操作');
      return;
    }
    const targetWire = wireJoin(parentWire, body.newName);
    const targetLocal = path.join(path.dirname(r.local), body.newName);
    if (
      path.basename(r.local).toLowerCase() !== body.newName.toLowerCase() &&
      (await statOrNull(targetLocal))
    ) {
      fail(res, 409, '已存在同名文件');
      return;
    }
    try {
      await fsp.rename(r.local, targetLocal);
      sendJson(res, 200, { ok: true, path: targetWire });
    } catch (e) {
      fail(res, 500, (e as Error).message || '重命名失败');
    }
  }

  async function handleMoveCopy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    isMove: boolean,
  ) {
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      fail(res, 400, (e as Error).message);
      return;
    }
    const src = resolvePathParam(res, body.path || '');
    if (!src) return;
    if (src.norm.isRoot) {
      fail(res, 400, '根目录不能这样操作');
      return;
    }
    const dst = resolvePathParam(res, body.destDir || '');
    if (!dst) return;
    const srcSt = await statOrNull(src.local);
    if (!srcSt) {
      fail(res, 404, '文件或目录不存在');
      return;
    }
    const dstSt = await statOrNull(dst.local);
    if (!dstSt) {
      fail(res, 404, '文件或目录不存在');
      return;
    }
    if (!dstSt.isDirectory()) {
      fail(res, 400, '目标不是文件夹');
      return;
    }
    const srcWireCmp = process.platform === 'win32' ? src.norm.wire.toLowerCase() : src.norm.wire;
    const dstWireCmp = process.platform === 'win32' ? dst.norm.wire.toLowerCase() : dst.norm.wire;
    if (dstWireCmp === srcWireCmp || dstWireCmp.startsWith(`${srcWireCmp}/`)) {
      fail(res, 400, '不能移动到自己里面');
      return;
    }
    const itemName = wireBaseName(src.norm.wire);
    const isDir = srcSt.isDirectory();
    const plainTargetLocal = path.join(dst.local, itemName);
    const plainTargetWire = wireJoin(dst.norm.wire, itemName);
    if (isMove && path.resolve(plainTargetLocal) === path.resolve(src.local)) {
      sendJson(res, 200, { ok: true, path: src.norm.wire });
      return;
    }
    const target = (await statOrNull(plainTargetLocal))
      ? await uniqueTarget(dst.local, dst.norm.wire, itemName, isDir)
      : { local: plainTargetLocal, wire: plainTargetWire, name: itemName };
    try {
      if (isMove) {
        try {
          await fsp.rename(src.local, target.local);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
            await fsp.cp(src.local, target.local, { recursive: true });
            await fsp.rm(src.local, { recursive: true, force: true });
          } else {
            throw e;
          }
        }
      } else {
        await fsp.cp(src.local, target.local, { recursive: true });
      }
      sendJson(res, 200, { ok: true, path: target.wire });
    } catch (e) {
      fail(res, 500, (e as Error).message || (isMove ? '移动失败' : '复制失败'));
    }
  }

  async function handleMessageFile(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!messageStore) {
      fail(res, 404, '接口不存在');
      return;
    }
    const fileId = messageStore.newFileId();
    const ws = messageStore.createStagingWriteStream(fileId);
    let written = 0;
    let settled = false;
    const cleanupPartial = () => messageStore.removeStaging(fileId);
    req.on('data', (c: Buffer) => {
      written += c.length;
      if (written > MAX_MESSAGE_FILE && !settled) {
        settled = true;
        try {
          ws.destroy();
        } catch {}
        try {
          req.destroy();
        } catch {}
        cleanupPartial();
        if (!res.headersSent) fail(res, 413, '附件过大');
      }
    });
    req.on('aborted', () => {
      if (settled) return;
      settled = true;
      try {
        ws.destroy();
      } catch {}
      cleanupPartial();
    });
    ws.on('error', (e) => {
      if (settled) return;
      settled = true;
      try {
        req.destroy();
      } catch {}
      cleanupPartial();
      if (!res.headersSent) fail(res, 500, e.message || '写入文件失败');
    });
    ws.on('finish', () => {
      if (settled) return;
      settled = true;
      sendJson(res, 200, { ok: true, fileId });
    });
    req.pipe(ws);
  }

  async function handleMessage(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!messageStore) {
      fail(res, 404, '接口不存在');
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      fail(res, 400, (e as Error).message);
      return;
    }
    const text = typeof body.text === 'string' ? body.text : '';
    const att = body.attachment as Record<string, unknown> | null | undefined;
    let attachment = null;
    if (att !== undefined && att !== null) {
      if (
        typeof att !== 'object' ||
        !isSafeFileId(att.fileId) ||
        typeof att.name !== 'string' ||
        !att.name ||
        typeof att.size !== 'number' ||
        att.size < 0
      ) {
        fail(res, 400, '附件信息不合法');
        return;
      }
      if (!messageStore.stagingExists(att.fileId)) {
        fail(res, 400, '附件文件不存在');
        return;
      }
      attachment = {
        fileId: att.fileId,
        name: att.name,
        size: att.size,
        mime: typeof att.mime === 'string' ? att.mime : '',
      };
    }
    if (!text && !attachment) {
      fail(res, 400, '消息内容为空');
      return;
    }
    const peerId = typeof body.fromId === 'string' && body.fromId ? body.fromId : 'unknown';
    if (attachment) {
      try {
        messageStore.commitAttachment(attachment.fileId, peerId);
      } catch {
        fail(res, 400, '附件文件不存在');
        return;
      }
    }
    const record = messageStore.add({
      deviceId: peerId,
      dir: 'in',
      text,
      from: typeof body.from === 'string' ? body.from : '',
      fromId: peerId === 'unknown' ? '' : peerId,
      time: typeof body.time === 'number' ? body.time : Date.now(),
      attachment,
      read: false,
    });
    if (onMessage) {
      try {
        onMessage(record);
      } catch {}
    }
    sendJson(res, 200, { ok: true });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      if (!pathname.startsWith('/api/')) {
        fail(res, 404, '接口不存在');
        return;
      }
      if (!checkAuth(req)) {
        fail(res, 401, '密码错误');
        return;
      }
      if (req.method === 'GET' && pathname === '/api/info') return handleInfo(req, res);
      if (req.method === 'GET' && pathname === '/api/roots') return handleRoots(req, res);
      if (req.method === 'GET' && pathname === '/api/list') return handleList(req, res, url.searchParams);
      if (req.method === 'GET' && pathname === '/api/stat') return handleStat(req, res, url.searchParams);
      if (req.method === 'GET' && pathname === '/api/download') return handleDownload(req, res, url.searchParams);
      if (req.method === 'GET' && pathname === '/api/quickaccess') return handleQuickAccess(req, res);
      if (req.method === 'GET' && pathname === '/api/thumbnail') return handleThumbnail(req, res, url.searchParams);
      if (req.method === 'POST' && pathname === '/api/upload') return handleUpload(req, res, url.searchParams);
      if (req.method === 'POST' && pathname === '/api/mkdir') return handleMkdir(req, res);
      if (req.method === 'POST' && pathname === '/api/delete') return handleDelete(req, res);
      if (req.method === 'POST' && pathname === '/api/rename') return handleRename(req, res);
      if (req.method === 'POST' && pathname === '/api/move') return handleMoveCopy(req, res, true);
      if (req.method === 'POST' && pathname === '/api/copy') return handleMoveCopy(req, res, false);
      if (req.method === 'POST' && pathname === '/api/message-file') return handleMessageFile(req, res);
      if (req.method === 'POST' && pathname === '/api/message') return handleMessage(req, res);
      fail(res, 404, '接口不存在');
    } catch (e) {
      if (!res.headersSent) fail(res, 500, (e as Error).message || '服务器内部错误');
      else {
        try {
          res.destroy();
        } catch {}
      }
    }
  }

  function startDiscovery(): Promise<void> {
    if (!enableDiscovery) return Promise.resolve();
    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', () => {
        if (udpSocket === sock) udpSocket = null;
        try {
          sock.close();
        } catch {}
        resolve();
      });
      sock.on('message', (msg, rinfo) => {
        if (!msg.equals(Buffer.from(DISCOVERY_REQUEST, 'ascii'))) return;
        const payload = buildDiscoveryResponse(name, actualPort, deviceId);
        sock.send(payload, rinfo.port, rinfo.address, () => {});
      });
      sock.bind(DISCOVERY_PORT, '0.0.0.0', () => {
        udpSocket = sock;
        resolve();
      });
    });
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        if (!password) {
          reject(new Error('密码为空，拒绝启动服务'));
          return;
        }
        if (running) {
          resolve({ port: actualPort });
          return;
        }
        ensureDrives()
          .then(() => {
            server = http.createServer(handle);
            const onListenError = (e: Error) => {
              running = false;
              reject(e);
            };
            server.on('error', onListenError);
            server.listen(port, '0.0.0.0', () => {
              if (!server) return;
              server.removeListener('error', onListenError);
              server.on('error', () => {});
              running = true;
              const addr = server.address();
              actualPort = typeof addr === 'object' && addr ? addr.port : port;
              startDiscovery().then(() => resolve({ port: actualPort }));
            });
          })
          .catch(reject);
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (udpSocket) {
          try {
            udpSocket.close();
          } catch {}
          udpSocket = null;
        }
        if (!server) {
          running = false;
          resolve();
          return;
        }
        const s = server;
        s.close(() => {
          server = null;
          running = false;
          resolve();
        });
        setTimeout(() => {
          if (server) {
            try {
              server.closeAllConnections();
            } catch {}
          }
        }, 1000);
      });
    },
    isRunning: () => running,
    getPort: () => actualPort,
  };
}
