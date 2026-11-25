/**
 * Windows 驱动器元数据解析工具（卷标、驱动器类型、映射网络盘 UNC）
 */
export const DRIVE_TYPE_NAMES: Record<number, string> = {
  2: '可移动磁盘',
  3: '本地磁盘',
  4: '网络驱动器',
  5: 'DVD 驱动器',
};

export interface DriveMetaEntry {
  label: string;
  type: number;
  unc?: string;
}

export function driveTypeName(type: number): string {
  return DRIVE_TYPE_NAMES[type] || '本地磁盘';
}

/** 解码控制台输出（兼容 UTF-16LE BOM、UTF-8 BOM、无 BOM UTF-16LE 及普通 UTF-8） */
export function decodeConsoleOutput(buf: Buffer | string | null | undefined): string {
  if (!buf) return '';
  if (!Buffer.isBuffer(buf)) return String(buf);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le', 2).replace(/^\uFEFF/, '');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8', 3);
  }
  let nulOdd = 0;
  const probe = Math.min(buf.length - 1, 512);
  for (let i = 0; i < probe; i += 2) {
    if (buf[i + 1] === 0) nulOdd++;
  }
  if (buf.length >= 4 && nulOdd > 4) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  return buf.toString('utf8');
}

export function parseWmicCsv(stdout: string): Record<string, DriveMetaEntry> {
  const map: Record<string, DriveMetaEntry> = {};
  if (!stdout) return map;
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return map;
  const header = lines[0].split(',').map((h) => h.trim());
  const idx: Record<string, number> = {};
  header.forEach((h, i) => {
    idx[h] = i;
  });
  for (const line of lines.slice(1)) {
    const parts = line.split(',');
    const letter = (parts[idx.DeviceID] || '').trim();
    if (!/^[A-Z]:$/.test(letter)) continue;
    map[letter] = {
      label: (parts[idx.VolumeName] || '').trim(),
      type: Number(parts[idx.DriveType]) || 3,
    };
  }
  return map;
}

export function parseNetUse(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!stdout) return out;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\S+\s+([A-Z]:)\s+(\\\\\S+)/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

export function parseVolOutput(stdout: string): string {
  if (!stdout) return '';
  const m = stdout.match(/(?:中的卷是|Volume in drive [A-Za-z] is)\s*([^\r\n]*)/);
  if (!m) return '';
  return (m[1] || '').trim();
}

export function driveDisplayName(d: DriveMetaEntry): string {
  if (d.label) return d.label;
  if (d.type === 4 && d.unc) {
    const share = d.unc.replace(/\\+$/, '').split('\\').filter(Boolean).pop();
    if (share) return share;
  }
  return driveTypeName(d.type);
}
