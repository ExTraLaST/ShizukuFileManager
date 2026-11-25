/**
 * 电脑版通用格式化、文件分类与排序工具
 */
import type { FileItem, SortField, SortOrder } from '../types';

export const IMAGE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.avif',
]);
export const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m2ts', '.ts', '.rmvb',
]);
export const AUDIO_EXTS = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.ape',
]);
export const ARCHIVE_EXTS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst',
]);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

export function isThumbable(item: FileItem): boolean {
  if (item.isDirectory) return false;
  const ext = item.extension || extOf(item.name);
  return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext);
}

export function isRemoteThumbable(item: FileItem): boolean {
  if (item.isDirectory) return false;
  const ext = item.extension || extOf(item.name);
  return IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext);
}

export function isArchive(item: FileItem): boolean {
  if (item.isDirectory) return false;
  const ext = item.extension || extOf(item.name);
  return ARCHIVE_EXTS.has(ext);
}

export function fileTypeLabel(item: FileItem): string {
  if (item.isDirectory) return '文件夹';
  const ext = (item.extension || extOf(item.name)).toLowerCase();
  if (!ext) return '文件';
  if (IMAGE_EXTS.has(ext)) return `${ext.slice(1).toUpperCase()} 图片`;
  if (VIDEO_EXTS.has(ext)) return `${ext.slice(1).toUpperCase()} 视频`;
  if (AUDIO_EXTS.has(ext)) return `${ext.slice(1).toUpperCase()} 音频`;
  if (ARCHIVE_EXTS.has(ext)) return `${ext.slice(1).toUpperCase()} 压缩包`;
  return `${ext.slice(1).toUpperCase()} 文件`;
}

export function sortFileItems(
  items: FileItem[],
  field: SortField,
  order: SortOrder,
): FileItem[] {
  const dir = order === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let cmp = 0;
    if (field === 'name') {
      cmp = a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    } else if (field === 'mtime') {
      cmp = (a.mtime || 0) - (b.mtime || 0);
    } else if (field === 'size') {
      cmp = (a.size || 0) - (b.size || 0);
    } else if (field === 'type') {
      cmp = fileTypeLabel(a).localeCompare(fileTypeLabel(b), 'zh-CN');
    }
    if (cmp === 0) cmp = a.name.localeCompare(b.name, 'zh-CN', { numeric: true });
    return cmp * dir;
  });
}

export function baseName(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  if (!clean) return p;
  if (/^[A-Za-z]:$/.test(clean)) return `${clean}\\`;
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || clean;
}
