/**
 * Windows 默认程序查询与启动模块
 * 读取注册表 UserChoice / HKCR\<ext> 解析该扩展名绑定的默认程序，
 * 让远程媒体 .m3u 直接交给该视频/音频扩展名设定的默认播放器（如 PotPlayer/VLC）打开。
 */
import { execFile, spawn } from 'child_process';
import fs from 'fs';

export function parseRegValue(text: unknown, valueName: string): string | null {
  if (typeof text !== 'string') return null;
  const want = valueName === '' ? '(Default)' : valueName;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(.+?)\s+REG_SZ\s+(.*)$/);
    if (!m) continue;
    if (m[1].trim() === want) {
      const v = m[2].trim();
      return v || null;
    }
  }
  return null;
}

function regQuery(key: string, args: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null);
      return;
    }
    const cmd = `chcp 65001 >nul & reg query "${key.replace(/"/g, '')}" ${args}`;
    execFile('cmd', ['/c', cmd], { timeout: 8000 }, (err, stdout) => {
      resolve(!err && stdout ? String(stdout) : null);
    });
  });
}

export async function getProgId(ext: string): Promise<string | null> {
  const clean = String(ext || '')
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, '');
  if (!clean.startsWith('.') || clean.length < 2) return null;
  const ucKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${clean}\\UserChoice`;
  const ucOut = await regQuery(ucKey, '/v ProgId');
  const ucProg = parseRegValue(ucOut, 'ProgId');
  if (ucProg) return ucProg;
  const extOut = await regQuery(`HKCR\\${clean}`, '/ve');
  return parseRegValue(extOut, '');
}

export function splitCommandLine(str: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && (c === ' ' || c === '\t')) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

export function parseOpenCommand(template: unknown): { exe: string; args: string[] } | null {
  if (typeof template !== 'string') return null;
  const s = template.trim();
  if (!s || /DelegateExecute/i.test(s)) return null;
  let exe: string | null = null;
  let rest = '';
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    if (end <= 1) return null;
    exe = s.slice(1, end);
    rest = s.slice(end + 1).trim();
  } else {
    const parts = s.split(/\s+/);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? `${acc} ${parts[i]}` : parts[i];
      if (/\.(exe|com|bat|cmd)$/i.test(acc)) {
        exe = acc;
        rest = parts.slice(i + 1).join(' ');
        break;
      }
    }
    if (!exe) return null;
  }
  const expanded = exe.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] || `%${name}%`);
  try {
    if (!fs.existsSync(expanded) && process.platform === 'win32') return null;
  } catch {
    return null;
  }
  return { exe: expanded, args: splitCommandLine(rest) };
}

export async function getDefaultOpenCommand(
  ext: string,
): Promise<{ exe: string; args: string[] } | null> {
  const progId = await getProgId(ext);
  if (!progId) return null;
  const cmdOut = await regQuery(`HKCR\\${progId}\\shell\\open\\command`, '/ve');
  const template = parseRegValue(cmdOut, '');
  if (!template) return null;
  return parseOpenCommand(template);
}

export async function openWithDefaultApp(ext: string, target: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  let cmd: { exe: string; args: string[] } | null;
  try {
    cmd = await getDefaultOpenCommand(ext);
  } catch {
    return false;
  }
  if (!cmd) return false;
  const args = cmd.args.map((a) =>
    a === '%1' || a === '%L' || a === '%*'
      ? target
      : a.replace(/%1/g, target).replace(/%L/g, target),
  );
  if (!cmd.args.some((a) => a.includes('%1') || a.includes('%L'))) args.push(target);
  try {
    const child = spawn(cmd.exe, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
