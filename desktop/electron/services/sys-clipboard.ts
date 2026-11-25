/**
 * Windows 系统剪贴板文件互通模块
 * 通过 CF_HDROP（UTF-16LE DROPFILES 结构）与 Preferred DropEffect（复制=1 / 剪切=2）
 * 实现本机文件与 Windows 资源管理器之间的双向复制、剪切与粘贴。
 */
export const DROPFILES_SIZE = 20;
export const DROPEFFECT_COPY = 1;
export const DROPEFFECT_MOVE = 2;

interface ElectronClipboard {
  writeBuffer(format: string, buffer: Buffer): void;
  readBuffer(format: string): Buffer;
  clear(): void;
}

function getClipboard(): ElectronClipboard | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron');
    return electron && electron.clipboard ? (electron.clipboard as ElectronClipboard) : null;
  } catch {
    return null;
  }
}

/** 将路径数组编码为 Windows CF_HDROP Buffer（UTF-16LE 双 NUL 结尾） */
export function encodeHDrop(paths: string[]): Buffer | null {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const header = Buffer.alloc(DROPFILES_SIZE);
  header.writeUInt32LE(DROPFILES_SIZE, 0); // pFiles
  header.writeUInt32LE(1, 16); // fWide = 1 (UTF-16LE)
  const parts: Buffer[] = [header];
  for (const p of paths) {
    parts.push(Buffer.from(String(p), 'utf16le'));
    parts.push(Buffer.from([0, 0]));
  }
  parts.push(Buffer.from([0, 0]));
  return Buffer.concat(parts);
}

/** 将 CF_HDROP Buffer 解码为路径数组 */
export function decodeHDrop(buf: Buffer): string[] | null {
  if (!Buffer.isBuffer(buf) || buf.length < DROPFILES_SIZE) return null;
  const pFiles = buf.readUInt32LE(0);
  const fWide = buf.readUInt32LE(16) !== 0;
  if (pFiles < DROPFILES_SIZE || pFiles >= buf.length) return null;
  const body = buf.subarray(pFiles);
  const paths: string[] = [];
  if (fWide) {
    let start = 0;
    for (let i = 0; i + 1 < body.length; i += 2) {
      if (body[i] === 0 && body[i + 1] === 0) {
        if (i === start) break;
        paths.push(body.toString('utf16le', start, i));
        start = i + 2;
      }
    }
  } else {
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === 0) {
        if (i === start) break;
        paths.push(body.toString('latin1', start, i));
        start = i + 1;
      }
    }
  }
  return paths.length ? paths : null;
}

/** 写入本机文件列表到 Windows 系统剪贴板 */
export function writeFiles(mode: 'copy' | 'cut', paths: string[]): boolean {
  if (process.platform !== 'win32') return false;
  const clip = getClipboard();
  if (!clip) return false;
  const buf = encodeHDrop(paths);
  if (!buf) return false;
  try {
    clip.writeBuffer('CF_HDROP', buf);
    const effect = Buffer.alloc(4);
    effect.writeUInt32LE(mode === 'cut' ? DROPEFFECT_MOVE : DROPEFFECT_COPY, 0);
    clip.writeBuffer('Preferred DropEffect', effect);
    return true;
  } catch {
    return false;
  }
}

/** 读取 Windows 系统剪贴板中的文件列表与复制/剪切模式 */
export function readFiles(): { mode: 'copy' | 'cut'; paths: string[] } | null {
  if (process.platform !== 'win32') return null;
  const clip = getClipboard();
  if (!clip) return null;
  try {
    const buf = clip.readBuffer('CF_HDROP');
    const paths = decodeHDrop(buf);
    if (!paths) return null;
    let mode: 'copy' | 'cut' = 'copy';
    try {
      const eff = clip.readBuffer('Preferred DropEffect');
      if (Buffer.isBuffer(eff) && eff.length >= 4 && eff.readUInt32LE(0) === DROPEFFECT_MOVE) {
        mode = 'cut';
      }
    } catch {}
    return { mode, paths };
  } catch {
    return null;
  }
}

/** 剪切粘贴完成后，仅当系统剪贴板仍匹配该批路径时清空 */
export function clearIfMatch(paths: string[]): boolean {
  if (process.platform !== 'win32') return false;
  const clip = getClipboard();
  if (!clip) return false;
  try {
    const cur = readFiles();
    if (!cur || !Array.isArray(paths)) return false;
    const a = [...cur.paths].sort();
    const b = [...paths].map(String).sort();
    if (a.length !== b.length || a.some((p, i) => p !== b[i])) return false;
    clip.clear();
    return true;
  } catch {
    return false;
  }
}
