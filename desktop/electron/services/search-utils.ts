/**
 * 本机递归文件搜索模块
 * 采用迭代式显式栈遍历（防深层目录栈溢出与符号链接死循环），支持随时取消与上限保护。
 */
import { promises as fsp } from 'fs';
import path from 'path';

export const DEFAULT_MAX_RESULTS = 500;
export const DEFAULT_MAX_SCANNED = 100000;

export interface LocalSearchItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  extension: string;
  icon: string;
}

export interface LocalSearchResult {
  items: LocalSearchItem[];
  scanned: number;
  truncated: boolean;
  cancelled: boolean;
}

export async function searchLocal({
  dir,
  query,
  maxResults = DEFAULT_MAX_RESULTS,
  maxScanned = DEFAULT_MAX_SCANNED,
  signal,
}: {
  dir: string;
  query: string;
  maxResults?: number;
  maxScanned?: number;
  signal?: AbortSignal;
}): Promise<LocalSearchResult> {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { items: [], scanned: 0, truncated: false, cancelled: false };

  const items: LocalSearchItem[] = [];
  let scanned = 0;
  let truncated = false;
  let cancelled = false;

  const stack = [dir];
  let sinceYield = 0;
  const checkCancel = () => {
    if (signal && signal.aborted) {
      cancelled = true;
      return true;
    }
    return false;
  };

  while (stack.length > 0) {
    if (checkCancel()) break;
    if (items.length >= maxResults || scanned >= maxScanned) {
      truncated = true;
      break;
    }
    const current = stack.pop()!;
    let ents;
    try {
      ents = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (checkCancel()) break;
      if (items.length >= maxResults || scanned >= maxScanned) {
        truncated = true;
        break;
      }
      if (ent.isSymbolicLink()) continue;
      scanned++;
      const full = path.join(current, ent.name);
      const isDir = ent.isDirectory();
      if (ent.name.toLowerCase().includes(q)) {
        let size = 0;
        let mtime = 0;
        try {
          const st = await fsp.stat(full);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {}
        items.push({
          name: ent.name,
          path: full,
          isDirectory: isDir,
          size: isDir ? 0 : size,
          mtime,
          extension: isDir ? '' : path.extname(ent.name).toLowerCase(),
          icon: '',
        });
      }
      if (isDir) stack.push(full);
      if (++sinceYield >= 500) {
        sinceYield = 0;
        await new Promise<void>((r) => setImmediate(r));
        if (checkCancel()) break;
      }
    }
  }

  return { items, scanned, truncated, cancelled };
}
