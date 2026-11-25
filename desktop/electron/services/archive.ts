/**
 * 压缩包查看、解压与压缩服务（基于内置 7za.exe）
 * 支持查看压缩包内部条目（7za l -slt）、带密码解压（zip/7z/rar/tar/gz/bz2/xz/zst）
 * 以及 zip（AES-256）/ 7z 5档压缩与实时进度解析。
 */
import { spawn, execFile, type ChildProcess } from 'child_process';

export const ARCHIVE_EXTS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.zst',
]);

export function isArchivePath(p: unknown): boolean {
  if (!p || typeof p !== 'string') return false;
  const i = p.lastIndexOf('.');
  if (i < 0) return false;
  return ARCHIVE_EXTS.has(p.slice(i).toLowerCase());
}

export const COMPRESS_LEVELS = [
  { key: 'fastest', mx: 0, label: '最快' },
  { key: 'fast', mx: 1, label: '快速' },
  { key: 'normal', mx: 5, label: '标准' },
  { key: 'maximum', mx: 7, label: '较高' },
  { key: 'ultra', mx: 9, label: '极限' },
] as const;

export type CompressLevelKey = (typeof COMPRESS_LEVELS)[number]['key'];

export function levelMx(key: string): number {
  const l = COMPRESS_LEVELS.find((x) => x.key === key);
  return l ? l.mx : 5;
}

export function validArchiveBaseName(name: unknown): name is string {
  if (!name || typeof name !== 'string') return false;
  if (name === '.' || name === '..') return false;
  if (/[\/\\:*?"<>|\x00-\x1f]/.test(name)) return false;
  if (/[. ]$/.test(name)) return false;
  return true;
}

export function archiveStem(fileName: string): string {
  const lower = fileName.toLowerCase();
  for (const comp of ['.tar.gz', '.tar.bz2', '.tar.xz', '.tar.zst']) {
    if (lower.endsWith(comp)) return fileName.slice(0, -comp.length);
  }
  const i = fileName.lastIndexOf('.');
  return i > 0 ? fileName.slice(0, i) : fileName;
}

const BASE_FLAGS = ['-y', '-bsp1', '-bso0', '-bse2'];

export function buildCompressArgs({
  format,
  level,
  password,
  outPath,
  sources,
}: {
  format: 'zip' | '7z';
  level: string;
  password?: string;
  outPath: string;
  sources: string[];
}): string[] {
  if (format !== 'zip' && format !== '7z') throw new Error(`不支持的压缩格式：${format}`);
  if (!Array.isArray(sources) || !sources.length) throw new Error('没有要压缩的文件');
  const args = ['a', `-t${format}`, `-mx=${levelMx(level)}`, ...BASE_FLAGS];
  if (password) {
    args.push(`-p${password}`);
    if (format === 'zip') args.push('-mem=AES256');
  }
  args.push(outPath, ...sources);
  return args;
}

export function buildExtractArgs({
  archivePath,
  outDir,
  password,
  entries,
}: {
  archivePath: string;
  outDir: string;
  password?: string;
  entries?: string[];
}): string[] {
  const args = ['x', ...BASE_FLAGS, `-o${outDir}`];
  if (password) args.push(`-p${password}`);
  args.push(archivePath);
  if (Array.isArray(entries) && entries.length > 0) {
    args.push(...entries);
  }
  return args;
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

/** 解析 `7za l -slt` 的技术输出为结构化压缩包条目列表 */
export function parseSltListing(stdout: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const sepIdx = stdout.indexOf('----------');
  if (sepIdx < 0) return entries;
  const body = stdout.slice(sepIdx + 10);
  const blocks = body.split(/\r?\n\r?\n+/);
  for (const block of blocks) {
    const kv: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const eq = line.indexOf(' = ');
      if (eq > 0) {
        kv[line.slice(0, eq).trim()] = line.slice(eq + 3).trim();
      }
    }
    const rawPath = kv.Path;
    if (!rawPath) continue;
    const normPath = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normPath) continue;
    const isDirectory =
      kv.Folder === '+' || (typeof kv.Attributes === 'string' && kv.Attributes.startsWith('D'));
    const size = Number(kv.Size) || 0;
    const packedSize = Number(kv['Packed Size']) || 0;
    const modified = kv.Modified ? Date.parse(kv.Modified.replace(' ', 'T')) || 0 : 0;
    const encrypted = kv.Encrypted === '+';
    const name = normPath.split('/').pop() || normPath;
    entries.push({ path: normPath, name, isDirectory, size, packedSize, modified, encrypted });
  }
  return entries;
}

/** 列出压缩包内部文件（支持传入密码查看加密头 7z 包） */
export function listArchiveEntries({
  exePath,
  archivePath,
  password,
}: {
  exePath: string;
  archivePath: string;
  password?: string;
}): Promise<{ ok: true; entries: ArchiveEntry[] } | { ok: false; code: string; error: string }> {
  return new Promise((resolve) => {
    const args = ['l', '-slt', '-sccUTF-8'];
    if (password) args.push(`-p${password}`);
    else args.push('-p');
    args.push(archivePath);
    execFile(
      exePath,
      args,
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) {
          const classified = classifyError({
            code: typeof err.code === 'number' ? err.code : 2,
            stderr: String(stderr || stdout || err.message),
          });
          resolve({ ok: false, code: classified.code, error: classified.message });
          return;
        }
        resolve({ ok: true, entries: parseSltListing(String(stdout || '')) });
      },
    );
  });
}

export function parseProgressText(text: string): { percent: number; current: string } | null {
  if (!text) return null;
  const clean = String(text).replace(/\x08/g, '');
  let percent: number | null = null;
  const pctRe = /(\d{1,3})%/g;
  let m: RegExpExecArray | null;
  while ((m = pctRe.exec(clean)) !== null) percent = Math.min(100, Number(m[1]));
  if (percent === null) return null;
  let current = '';
  const fileRe = /\d{1,3}%\s*(?:\d+\s+)?[+T]\s+([^\r\n]+)/g;
  while ((m = fileRe.exec(clean)) !== null) current = m[1].trim();
  return { percent, current };
}

export function classifyError({ code, stderr }: { code: number; stderr?: string }) {
  const text = (stderr || '').trim();
  if (/wrong password/i.test(text) || /data error in encrypted file/i.test(text)) {
    return { code: 'PASSWORD', message: '密码错误或压缩包需要密码' };
  }
  if (/is not archive/i.test(text) || /can not open the file as/i.test(text)) {
    return { code: 'NOT_ARCHIVE', message: '不是有效的压缩包或文件已损坏' };
  }
  if (/access is denied|permission denied/i.test(text)) {
    return { code: 'ACCESS', message: '没有权限访问该文件或目录' };
  }
  if (/can not open output file|cannot open output/i.test(text)) {
    return { code: 'OUTPUT', message: '无法创建输出文件（目标可能被占用）' };
  }
  if (/can not open .* as archive|no such file or directory|the system cannot find/i.test(text)) {
    return { code: 'NOT_FOUND', message: '找不到源文件或压缩包已被移动/删除' };
  }
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l);
  return { code: 'FAILED', message: first ? first.slice(0, 200) : `7-Zip 退出码 ${code}` };
}

export function runSevenZip({
  exePath,
  args,
  cwd,
  onProgress,
}: {
  exePath: string;
  args: string[];
  cwd?: string;
  onProgress?: (p: { percent: number; current: string }) => void;
}) {
  let child: ChildProcess | null = null;
  let cancelled = false;
  let settled = false;
  let stderrBuf = '';

  const promise = new Promise<{ cancelled: boolean; code?: number; stderr?: string }>((resolve) => {
    const done = (v: { cancelled: boolean; code?: number; stderr?: string }) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      child = spawn(exePath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      done({ cancelled: false, code: -1, stderr: String((e as Error)?.message || e) });
      return;
    }
    child.stdout?.on('data', (d: Buffer) => {
      if (cancelled) return;
      const p = parseProgressText(d.toString('utf8'));
      if (p && onProgress) onProgress(p);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf = (stderrBuf + d.toString('utf8')).slice(-8192);
    });
    child.on('error', (e) => done({ cancelled: false, code: -1, stderr: String(e.message || e) }));
    child.on('close', (code) =>
      done({ cancelled, code: code === null ? -1 : code, stderr: stderrBuf }),
    );
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      if (child) {
        try {
          child.kill();
        } catch {}
      }
    },
  };
}
