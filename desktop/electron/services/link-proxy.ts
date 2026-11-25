/**
 * 远程媒体本地流播代理（电脑版内置模块）
 * 将远程手机/电脑的 /api/download（带 X-Shizuku-Token 与 Range 支持）
 * 暴露为本地局域网 HTTP 流地址，并配合 .m3u 交给 Windows 默认播放器直接流式播放。
 * 绑定 0.0.0.0 并优先使用本机局域网 IPv4，以兼容 Win11 UWP 媒体播放器的回环隔离限制。
 */
import http from 'http';
import crypto from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { LinkConnection } from './link-client';

export const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m2ts', '.ts', '.rmvb',
]);
export const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape',
]);

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
  '.m2ts': 'video/mp2t',
  '.ts': 'video/mp2t',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  '.ape': 'audio/x-ape',
};

const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const HEAD_TIMEOUT_MS = 10000;

function extOfPath(p: string): string {
  const i = p.lastIndexOf('.');
  return i >= 0 ? p.slice(i).toLowerCase() : '';
}

export function isMediaPath(wirePath: string): boolean {
  const ext = extOfPath(wirePath);
  return VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
}

export function mimeForPath(wirePath: string): string {
  return MIME_BY_EXT[extOfPath(wirePath)] || 'application/octet-stream';
}

export function parseProxyPath(pathname: string): { id: string; filename: string } | null {
  const m = /^\/stream\/([0-9a-f]{32})\/(.+)$/.exec(pathname);
  if (!m) return null;
  return { id: m[1], filename: m[2] };
}

export function buildPlaylistContent(displayName: string, url: string): string {
  const safeName = String(displayName).replace(/[\r\n]/g, ' ');
  return `#EXTM3U\n#EXTINF:-1,${safeName}\n${url}\n`;
}

function upstreamDownloadUrl(conn: LinkConnection, wirePath: string): string {
  return `http://${conn.host}:${conn.port || 8898}/api/download?path=${encodeURIComponent(wirePath)}`;
}

/** 流播前快速 Range 探测，确认文件存在且鉴权通过 */
export async function probeStream(
  conn: LinkConnection,
  wirePath: string,
  { timeoutMs = PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(upstreamDownloadUrl(conn, wirePath), {
      headers: { 'X-Shizuku-Token': conn.password || '', Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return false;
  }
  try {
    if (res.body) await res.body.cancel();
  } catch {}
  return res.status === 200 || res.status === 206;
}

interface Registration {
  conn: Required<LinkConnection>;
  wirePath: string;
  lastUsed: number;
}

export function createMediaProxy(options: { resolveHost?: () => string | null } = {}) {
  const resolveHost = typeof options.resolveHost === 'function' ? options.resolveHost : null;
  let server: http.Server | null = null;
  let port = 0;
  let starting: Promise<number> | null = null;
  const registrations = new Map<string, Registration>();

  function prune(): void {
    const now = Date.now();
    for (const [id, r] of registrations) {
      if (now - r.lastUsed > REGISTRATION_TTL_MS) registrations.delete(id);
    }
  }

  function streamHost(): string {
    try {
      const h = resolveHost ? resolveHost() : null;
      if (typeof h === 'string' && h) return h;
    } catch {}
    return '127.0.0.1';
  }

  function sendJson(res: http.ServerResponse, status: number, obj: unknown): void {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  async function forwardGet(reg: Registration, req: http.IncomingMessage, res: http.ServerResponse) {
    const headers: Record<string, string> = { 'X-Shizuku-Token': reg.conn.password };
    const range = req.headers.range;
    if (typeof range === 'string' && range) headers.Range = range;

    const ctrl = new AbortController();
    const onResClose = () => {
      try {
        ctrl.abort();
      } catch {}
    };
    res.on('close', onResClose);

    let up: Response;
    try {
      up = await fetch(upstreamDownloadUrl(reg.conn, reg.wirePath), {
        headers,
        signal: ctrl.signal,
      });
    } catch {
      res.off('close', onResClose);
      if (!res.destroyed && !res.headersSent) {
        sendJson(res, 502, { ok: false, error: 'upstream unreachable' });
      }
      return;
    }

    const outHeaders: Record<string, string> = { 'Content-Type': mimeForPath(reg.wirePath) };
    const len = up.headers.get('content-length');
    if (len) outHeaders['Content-Length'] = len;
    const cr = up.headers.get('content-range');
    if (cr) outHeaders['Content-Range'] = cr;
    const ar = up.headers.get('accept-ranges');
    if (ar) outHeaders['Accept-Ranges'] = ar;

    res.writeHead(up.status, outHeaders);
    if (!up.body) {
      res.off('close', onResClose);
      res.end();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(up.body as unknown as import('stream/web').ReadableStream), res);
    } catch {
      try {
        if (!res.destroyed) res.end();
      } catch {}
    } finally {
      res.off('close', onResClose);
    }
  }

  async function handleHead(reg: Registration, res: http.ServerResponse) {
    let up: Response;
    try {
      up = await fetch(upstreamDownloadUrl(reg.conn, reg.wirePath), {
        headers: { 'X-Shizuku-Token': reg.conn.password, Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      });
    } catch {
      sendJson(res, 502, { ok: false, error: 'upstream unreachable' });
      return;
    }
    try {
      if (up.body) await up.body.cancel();
    } catch {}
    if (up.status === 206) {
      const cr = up.headers.get('content-range') || '';
      const m = /\/(\d+)\s*$/.exec(cr);
      const h: Record<string, string> = {
        'Content-Type': mimeForPath(reg.wirePath),
        'Accept-Ranges': 'bytes',
      };
      if (m) h['Content-Length'] = m[1];
      res.writeHead(200, h);
      res.end();
      return;
    }
    if (up.status === 200) {
      const h: Record<string, string> = { 'Content-Type': mimeForPath(reg.wirePath) };
      const len = up.headers.get('content-length');
      if (len) h['Content-Length'] = len;
      const ar = up.headers.get('accept-ranges');
      if (ar) h['Accept-Ranges'] = ar;
      res.writeHead(200, h);
      res.end();
      return;
    }
    res.writeHead(up.status, { 'Content-Type': 'application/json' });
    res.end();
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const parsed = parseProxyPath(u.pathname);
      if (!parsed) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const reg = registrations.get(parsed.id);
      if (!reg) {
        sendJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      reg.lastUsed = Date.now();
      if (req.method === 'HEAD') return handleHead(reg, res);
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return;
      }
      await forwardGet(reg, req, res);
    } catch {
      try {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'proxy error' });
        else res.end();
      } catch {}
    }
  }

  async function ensureStarted(): Promise<number> {
    if (server) return port;
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const s = http.createServer(handleRequest);
      s.on('error', (e) => {
        if (server === s) {
          server = null;
          port = 0;
        }
        starting = null;
        reject(e);
      });
      s.listen(0, '0.0.0.0', () => {
        server = s;
        const addr = s.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        starting = null;
        resolve(port);
      });
    });
    return starting;
  }

  async function streamUrl(conn: LinkConnection, wirePath: string): Promise<string> {
    const p = await ensureStarted();
    prune();
    const id = crypto.randomBytes(16).toString('hex');
    registrations.set(id, {
      conn: { host: conn.host, port: conn.port || 8898, password: conn.password || '' },
      wirePath,
      lastUsed: Date.now(),
    });
    const base = wirePath.replace(/\/+$/, '').split('/').pop() || 'media';
    return `http://${streamHost()}:${p}/stream/${id}/${encodeURIComponent(base)}`;
  }

  async function stop(): Promise<void> {
    if (!server) return;
    const s = server;
    server = null;
    port = 0;
    registrations.clear();
    await new Promise<void>((resolve) => {
      try {
        s.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  return {
    ensureStarted,
    streamUrl,
    probe: probeStream,
    stop,
    get port() {
      return port;
    },
  };
}
