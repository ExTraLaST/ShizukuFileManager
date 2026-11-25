/**
 * Shizuku 互联客户端（电脑版内置模块）
 * 严格遵循 docs/PROTOCOL.md（Shizuku 互联协议 v1）
 * 负责访问远程手机/电脑设备、流式上传下载、远程缩略图、消息附件收发及 UDP 自动发现。
 */
import fs from 'fs';
import dgram from 'dgram';
import os from 'os';
import { Readable } from 'stream';
import {
  DISCOVERY_PORT,
  DISCOVERY_REQUEST,
  DISCOVERY_RESPONSE_PREFIX,
  PROTOCOL_VERSION,
} from './link-server';

export const CONNECT_TIMEOUT_MS = 5000;
export const SMALL_REQUEST_TIMEOUT_MS = 15000;
export const SCAN_DURATION_MS = 2500;
export const SCAN_ROUNDS = 3;
export const SCAN_INTERVAL_MS = 300;

export interface LinkConnection {
  host: string;
  port?: number;
  password?: string;
}

export interface LinkDeviceInfo {
  ok: true;
  name: string;
  type: 'pc' | 'phone';
  version: number;
  id?: string;
}

export interface LinkRootItem {
  name: string;
  path: string;
  free: number;
  total: number;
}

export interface LinkFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
}

export interface LinkStatResult {
  ok: true;
  exists: boolean;
  isDirectory: boolean;
  size: number;
  modified: number;
}

export interface DiscoveredDevice {
  name: string;
  type: 'pc' | 'phone';
  host: string;
  port: number;
  id: string | null;
}

export interface OutgoingLinkMessage {
  text?: string;
  from: string;
  fromId: string;
  time: number;
  attachment?: {
    fileId: string;
    name: string;
    size: number;
    mime: string;
  };
}

export class LinkError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'LinkError';
    this.status = status;
  }
}

export function createLinkClient({ host, port = 8898, password = '' }: LinkConnection) {
  const base = `http://${host}:${port}`;
  const tokenHeader = { 'X-Shizuku-Token': password };

  function networkErrorText(): string {
    return `连不上 ${host}:${port}，确认对方已开启服务且在同一网络`;
  }

  function combineSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
    const signals: AbortSignal[] = [];
    if (signal) signals.push(signal);
    if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
    if (signals.length === 0) return undefined;
    if (signals.length === 1) return signals[0];
    return AbortSignal.any(signals);
  }

  function translateFetchError(e: unknown, signal?: AbortSignal): LinkError {
    if (e && (e as Error).name === 'AbortError') {
      if (signal && signal.aborted) return new LinkError('已取消', 0);
      return new LinkError('连接超时', 0);
    }
    return new LinkError(networkErrorText(), 0);
  }

  async function parseErrorBody(res: Response): Promise<string> {
    try {
      const data = (await res.json()) as { error?: string };
      if (data && typeof data.error === 'string' && data.error) return data.error;
    } catch {}
    return `请求失败 (HTTP ${res.status})`;
  }

  async function requestJson<T>(
    endpoint: string,
    {
      method = 'GET',
      body,
      signal,
      timeoutMs = SMALL_REQUEST_TIMEOUT_MS,
    }: {
      method?: string;
      body?: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    let res: Response;
    try {
      const headers: Record<string, string> = { ...tokenHeader };
      const opts: RequestInit = {
        method,
        headers,
        signal: combineSignal(signal, timeoutMs),
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json; charset=utf-8';
        opts.body = JSON.stringify(body);
      }
      res = await fetch(base + endpoint, opts);
    } catch (e) {
      throw translateFetchError(e, signal);
    }
    let data: { ok?: boolean; error?: string };
    try {
      data = (await res.json()) as { ok?: boolean; error?: string };
    } catch {
      throw new LinkError(`服务器返回异常 (HTTP ${res.status})`, res.status);
    }
    if (!res.ok || !data.ok) {
      throw new LinkError(data.error || `请求失败 (HTTP ${res.status})`, res.status);
    }
    return data as T;
  }

  const q = (p: string) => `?path=${encodeURIComponent(p)}`;

  return {
    host,
    port,

    async info(signal?: AbortSignal): Promise<LinkDeviceInfo> {
      const data = await requestJson<LinkDeviceInfo>('/api/info', {
        signal,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
      if (data.version !== PROTOCOL_VERSION) throw new LinkError('版本不兼容', 0);
      return data;
    },

    roots(signal?: AbortSignal): Promise<{ ok: true; roots: LinkRootItem[] }> {
      return requestJson('/api/roots', { signal });
    },

    quickAccess(signal?: AbortSignal): Promise<{ ok: true; items: Array<{ name: string; path: string }> }> {
      return requestJson('/api/quickaccess', { signal });
    },

    list(wirePath: string, signal?: AbortSignal): Promise<{ ok: true; items: LinkFileEntry[] }> {
      return requestJson(`/api/list${q(wirePath)}`, { signal });
    },

    stat(wirePath: string, signal?: AbortSignal): Promise<LinkStatResult> {
      return requestJson(`/api/stat${q(wirePath)}`, { signal });
    },

    async exists(wirePath: string, signal?: AbortSignal): Promise<boolean> {
      const r = await this.stat(wirePath, signal);
      return r.exists;
    },

    async thumbnail(
      wirePath: string,
      size = 256,
    ): Promise<{ buffer: Buffer; contentType: string }> {
      let res: Response;
      try {
        res = await fetch(
          `${base}/api/thumbnail?path=${encodeURIComponent(wirePath)}&size=${encodeURIComponent(String(size))}`,
          {
            headers: { ...tokenHeader },
            signal: combineSignal(undefined, SMALL_REQUEST_TIMEOUT_MS),
          },
        );
      } catch (e) {
        throw translateFetchError(e);
      }
      if (!res.ok) throw new LinkError(await parseErrorBody(res), res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      return { buffer: buf, contentType: res.headers.get('content-type') || '' };
    },

    mkdir(wirePath: string, signal?: AbortSignal): Promise<{ ok: true }> {
      return requestJson('/api/mkdir', { method: 'POST', body: { path: wirePath }, signal });
    },

    deleteOne(wirePath: string, signal?: AbortSignal): Promise<{ ok: true }> {
      return requestJson('/api/delete', { method: 'POST', body: { path: wirePath }, signal });
    },

    rename(wirePath: string, newName: string, signal?: AbortSignal): Promise<{ ok: true; path: string }> {
      return requestJson('/api/rename', {
        method: 'POST',
        body: { path: wirePath, newName },
        signal,
      });
    },

    move(wirePath: string, destDir: string, signal?: AbortSignal): Promise<{ ok: true; path: string }> {
      return requestJson('/api/move', {
        method: 'POST',
        body: { path: wirePath, destDir },
        signal,
      });
    },

    copy(wirePath: string, destDir: string, signal?: AbortSignal): Promise<{ ok: true; path: string }> {
      return requestJson('/api/copy', {
        method: 'POST',
        body: { path: wirePath, destDir },
        signal,
      });
    },

    async downloadToFile(
      remotePath: string,
      localPath: string,
      {
        signal,
        onProgress,
      }: { signal?: AbortSignal; onProgress?: (written: number, total: number) => void } = {},
    ): Promise<{ size: number; total: number }> {
      let res: Response;
      try {
        res = await fetch(`${base}/api/download${q(remotePath)}`, {
          headers: { ...tokenHeader },
          signal: signal || undefined,
        });
      } catch (e) {
        throw translateFetchError(e, signal);
      }
      if (!res.ok) throw new LinkError(await parseErrorBody(res), res.status);
      const total = Number(res.headers.get('content-length')) || 0;
      const ws = fs.createWriteStream(localPath);
      let written = 0;
      let failed: unknown = null;
      try {
        if (!res.body) throw new LinkError('空响应体', 0);
        const reader = res.body.getReader();
        try {
          for (;;) {
            if (signal && signal.aborted) throw new LinkError('已取消', 0);
            const { done, value } = await reader.read();
            if (done) break;
            written += value.byteLength;
            if (!ws.write(value)) await new Promise<void>((r) => ws.once('drain', r));
            if (onProgress) onProgress(written, total);
          }
        } finally {
          try {
            reader.releaseLock();
          } catch {}
        }
      } catch (e) {
        failed = e;
      }
      await new Promise<void>((resolve) => {
        ws.end(() => resolve());
      });
      if (failed) {
        try {
          fs.unlinkSync(localPath);
        } catch {}
        throw failed;
      }
      return { size: written, total };
    },

    async downloadStream(
      remotePath: string,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
      let res: Response;
      try {
        res = await fetch(`${base}/api/download${q(remotePath)}`, {
          headers: { ...tokenHeader },
          signal: signal || undefined,
        });
      } catch (e) {
        throw translateFetchError(e, signal);
      }
      if (!res.ok) throw new LinkError(await parseErrorBody(res), res.status);
      if (!res.body) throw new LinkError('空响应体', 0);
      return {
        stream: res.body,
        size: Number(res.headers.get('content-length')) || 0,
      };
    },

    async uploadFile(
      localPath: string,
      remotePath: string,
      {
        signal,
        onProgress,
      }: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {},
    ): Promise<{ ok: true; size: number }> {
      const st = await fs.promises.stat(localPath);
      const nodeStream = fs.createReadStream(localPath, { highWaterMark: 256 * 1024 });
      let sent = 0;
      nodeStream.on('data', (c: string | Buffer) => {
        sent += Buffer.byteLength(c);
        if (onProgress) onProgress(sent, st.size);
      });
      let res: Response;
      try {
        res = await fetch(`${base}/api/upload${q(remotePath)}`, {
          method: 'POST',
          headers: { ...tokenHeader, 'Content-Length': String(st.size) },
          body: Readable.toWeb(nodeStream) as unknown as BodyInit,
          // @ts-expect-error Node fetch 流式请求需要 duplex: 'half'
          duplex: 'half',
          signal: signal || undefined,
        });
      } catch (e) {
        try {
          nodeStream.destroy();
        } catch {}
        throw translateFetchError(e, signal);
      }
      let data: { ok?: boolean; error?: string; size?: number };
      try {
        data = (await res.json()) as { ok?: boolean; error?: string; size?: number };
      } catch {
        throw new LinkError(`服务器返回异常 (HTTP ${res.status})`, res.status);
      }
      if (!res.ok || !data.ok) {
        throw new LinkError(data.error || `上传失败 (HTTP ${res.status})`, res.status);
      }
      return { ok: true, size: data.size ?? st.size };
    },

    async uploadStream(
      webStream: ReadableStream<Uint8Array>,
      remotePath: string,
      { signal, size = 0 }: { signal?: AbortSignal; size?: number } = {},
    ): Promise<{ ok: true; size: number }> {
      const headers: Record<string, string> = { ...tokenHeader };
      if (size > 0) headers['Content-Length'] = String(size);
      let res: Response;
      try {
        res = await fetch(`${base}/api/upload${q(remotePath)}`, {
          method: 'POST',
          headers,
          body: webStream as unknown as BodyInit,
          // @ts-expect-error Node fetch 流式请求需要 duplex: 'half'
          duplex: 'half',
          signal: signal || undefined,
        });
      } catch (e) {
        throw translateFetchError(e, signal);
      }
      let data: { ok?: boolean; error?: string; size?: number };
      try {
        data = (await res.json()) as { ok?: boolean; error?: string; size?: number };
      } catch {
        throw new LinkError(`服务器返回异常 (HTTP ${res.status})`, res.status);
      }
      if (!res.ok || !data.ok) {
        throw new LinkError(data.error || `上传失败 (HTTP ${res.status})`, res.status);
      }
      return { ok: true, size: data.size ?? size };
    },

    async uploadBuffer(
      remotePath: string,
      buffer: Buffer,
      { signal }: { signal?: AbortSignal } = {},
    ): Promise<{ ok: true; size: number }> {
      let res: Response;
      try {
        res = await fetch(`${base}/api/upload${q(remotePath)}`, {
          method: 'POST',
          headers: { ...tokenHeader, 'Content-Length': String(buffer.length) },
          body: new Uint8Array(buffer),
          signal: combineSignal(signal, SMALL_REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        throw translateFetchError(e, signal);
      }
      let data: { ok?: boolean; error?: string; size?: number };
      try {
        data = (await res.json()) as { ok?: boolean; error?: string; size?: number };
      } catch {
        throw new LinkError(`服务器返回异常 (HTTP ${res.status})`, res.status);
      }
      if (!res.ok || !data.ok) {
        throw new LinkError(data.error || `上传失败 (HTTP ${res.status})`, res.status);
      }
      return { ok: true, size: data.size ?? buffer.length };
    },

    async uploadMessageFile(
      localPath: string,
      {
        signal,
        onProgress,
      }: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {},
    ): Promise<{ ok: true; fileId: string }> {
      const st = await fs.promises.stat(localPath);
      const nodeStream = fs.createReadStream(localPath, { highWaterMark: 256 * 1024 });
      let sent = 0;
      nodeStream.on('data', (c: string | Buffer) => {
        sent += Buffer.byteLength(c);
        if (onProgress) onProgress(sent, st.size);
      });
      const filename = localPath.split(/[\\/]/).pop() || 'file';
      let res: Response;
      try {
        res = await fetch(`${base}/api/message-file?filename=${encodeURIComponent(filename)}`, {
          method: 'POST',
          headers: { ...tokenHeader, 'Content-Length': String(st.size) },
          body: Readable.toWeb(nodeStream) as unknown as BodyInit,
          // @ts-expect-error Node fetch 流式请求需要 duplex: 'half'
          duplex: 'half',
          signal: signal || undefined,
        });
      } catch (e) {
        try {
          nodeStream.destroy();
        } catch {}
        throw translateFetchError(e, signal);
      }
      let data: { ok?: boolean; error?: string; fileId?: string };
      try {
        data = (await res.json()) as { ok?: boolean; error?: string; fileId?: string };
      } catch {
        throw new LinkError(`服务器返回异常 (HTTP ${res.status})`, res.status);
      }
      if (!res.ok || !data.ok || !data.fileId) {
        throw new LinkError(data.error || `上传失败 (HTTP ${res.status})`, res.status);
      }
      return { ok: true, fileId: data.fileId };
    },

    sendMessage(message: OutgoingLinkMessage, { signal }: { signal?: AbortSignal } = {}) {
      return requestJson<{ ok: true }>('/api/message', { method: 'POST', body: message, signal });
    },
  };
}

// ---------------- UDP 自动发现 ----------------

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIpv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export function subnetBroadcastAddrs(): string[] {
  const out = new Set<string>();
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const a of ifs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) continue;
      const b = (ipv4ToInt(a.address) & ipv4ToInt(a.netmask)) | ~ipv4ToInt(a.netmask);
      out.add(intToIpv4(b));
    }
  }
  return [...out];
}

export function localIpv4Addrs(): Set<string> {
  const out = new Set<string>();
  for (const ifs of Object.values(os.networkInterfaces())) {
    for (const a of ifs || []) {
      if (a.family === 'IPv4') out.add(a.address);
    }
  }
  return out;
}

/** 解析 UDP 自动发现回应报文 */
export function parseDiscoveryResponse(
  text: string,
  sourceIp: string,
  localIps: Set<string>,
): DiscoveredDevice | null {
  if (localIps.has(sourceIp)) return null;
  if (!text.startsWith(DISCOVERY_RESPONSE_PREFIX)) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text.slice(DISCOVERY_RESPONSE_PREFIX.length));
  } catch {
    return null;
  }
  if (!data || data.version !== PROTOCOL_VERSION) return null;
  const port = Number(data.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    name: typeof data.name === 'string' && data.name ? data.name : sourceIp,
    type: data.type === 'phone' ? 'phone' : 'pc',
    host: sourceIp,
    port,
    id: typeof data.id === 'string' && data.id ? data.id : null,
  };
}

/** 扫描局域网内开启 Shizuku 互联服务的设备 */
export function scanLinkDevices({
  timeoutMs = SCAN_DURATION_MS,
  signal,
  includeLocal = false,
}: {
  timeoutMs?: number;
  signal?: AbortSignal;
  includeLocal?: boolean;
} = {}): Promise<DiscoveredDevice[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredDevice>();
    const localIps = includeLocal ? new Set<string>() : localIpv4Addrs();
    const socket = dgram.createSocket('udp4');
    let timer: NodeJS.Timeout | null = null;
    let interval: NodeJS.Timeout | null = null;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
      if (signal) signal.removeEventListener('abort', finish);
      try {
        socket.close();
      } catch {}
      resolve([...found.values()]);
    };

    if (signal) {
      if (signal.aborted) {
        resolve([]);
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    }

    socket.on('message', (msg, rinfo) => {
      if (finished) return;
      const dev = parseDiscoveryResponse(msg.toString('utf8'), rinfo.address, localIps);
      if (!dev) return;
      const key = `${dev.host}:${dev.port}`;
      if (!found.has(key)) found.set(key, dev);
    });

    socket.on('error', () => finish());
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        finish();
        return;
      }
      const targets = includeLocal
        ? ['127.0.0.1', '255.255.255.255', ...subnetBroadcastAddrs()]
        : ['255.255.255.255', ...subnetBroadcastAddrs()];
      const sendRound = () => {
        for (const addr of targets) {
          socket.send(DISCOVERY_REQUEST, DISCOVERY_PORT, addr, () => {});
        }
      };
      sendRound();
      let rounds = 1;
      interval = setInterval(() => {
        if (rounds >= SCAN_ROUNDS) {
          if (interval) clearInterval(interval);
          interval = null;
          return;
        }
        rounds++;
        sendRound();
      }, SCAN_INTERVAL_MS);
      timer = setTimeout(finish, timeoutMs);
    });
  });
}
