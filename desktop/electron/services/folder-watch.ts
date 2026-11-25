/**
 * 文件夹自动刷新监听模块（800ms 安静期防抖）
 * 本机磁盘使用 fs.watch；映射网络盘或远程目录由渲染层自动切换轮询刷新。
 */
import fs from 'fs';

export const DEBOUNCE_MS = 800;

interface WatchEntry {
  watcher: fs.FSWatcher;
  dirPath: string;
  timer: NodeJS.Timeout | null;
}

export function createFolderWatcher({
  onChanged,
  onFailed,
}: {
  onChanged?: (paneId: string) => void;
  onFailed?: (paneId: string) => void;
}) {
  const watchers = new Map<string, WatchEntry>();

  function clear(paneId: string) {
    const w = watchers.get(paneId);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    try {
      w.watcher.close();
    } catch {}
    watchers.delete(paneId);
  }

  function watch(paneId: string, dirPath: string): 'none' | 'same' | 'watch' | 'error' {
    if (!dirPath) {
      clear(paneId);
      return 'none';
    }
    const cur = watchers.get(paneId);
    if (cur && cur.dirPath === dirPath) return 'same';
    clear(paneId);
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dirPath, { persistent: false }, () => {
        const entry = watchers.get(paneId);
        if (!entry) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          if (onChanged) onChanged(paneId);
        }, DEBOUNCE_MS);
      });
    } catch {
      return 'error';
    }
    watcher.on('error', () => {
      clear(paneId);
      if (onFailed) onFailed(paneId);
    });
    watchers.set(paneId, { watcher, dirPath, timer: null });
    return 'watch';
  }

  function clearAll() {
    for (const paneId of [...watchers.keys()]) clear(paneId);
  }

  return { watch, clear, clearAll };
}
