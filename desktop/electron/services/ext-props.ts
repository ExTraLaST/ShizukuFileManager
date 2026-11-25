/**
 * Windows Shell 扩展属性读取器（作者、标题、分辨率、时长、艺术家、专辑等）
 */
import { execFile } from 'child_process';

export const EXT_PROPS: ReadonlyArray<readonly [string, string]> = [
  ['System.Author', 'author'],
  ['System.Title', 'title'],
  ['System.Subject', 'subject'],
  ['System.Image.HorizontalSize', 'imgW'],
  ['System.Image.VerticalSize', 'imgH'],
  ['System.Video.FrameWidth', 'vidW'],
  ['System.Video.FrameHeight', 'vidH'],
  ['System.Media.Duration', 'duration'],
  ['System.Music.Artist', 'artist'],
  ['System.Music.Album', 'album'],
  ['System.Keywords', 'keywords'],
  ['System.Comment', 'comment'],
];

export function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

export function buildExtPropsScript(filePath: string): string {
  const propList = EXT_PROPS.map(([p]) => psQuote(p)).join(',');
  return [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    '$ErrorActionPreference = "SilentlyContinue";',
    '$shell = New-Object -ComObject Shell.Application;',
    `$dir = [System.IO.Path]::GetDirectoryName(${psQuote(filePath)});`,
    `$name = [System.IO.Path]::GetFileName(${psQuote(filePath)});`,
    '$ns = $shell.Namespace($dir);',
    'if ($null -eq $ns) { "{}"; exit; }',
    '$item = $ns.ParseName($name);',
    'if ($null -eq $item) { "{}"; exit; }',
    '$out = @{};',
    `foreach ($p in @(${propList})) {`,
    '  $v = $item.ExtendedProperty($p);',
    '  if ($null -ne $v -and "$v" -ne "") { $out[$p] = "$v"; }',
    '}',
    'if ($out.Count -eq 0) { "{}"; } else { $out | ConvertTo-Json -Compress; }',
  ].join('\n');
}

export function parseExtPropsOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const keyOf = new Map(EXT_PROPS);
  for (const [full, value] of Object.entries(parsed as Record<string, unknown>)) {
    const short = keyOf.get(full);
    if (!short || value == null) continue;
    const s = String(value);
    if (s) out[short] = s;
  }
  return out;
}

export function getExtendedProps(
  filePath: string,
  opts: { timeout?: number; powershell?: string } = {},
): Promise<Record<string, string>> {
  if (process.platform !== 'win32') return Promise.resolve({});
  const timeout = opts.timeout || 5000;
  const ps = opts.powershell || 'powershell.exe';
  return new Promise((resolve) => {
    execFile(
      ps,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildExtPropsScript(filePath),
      ],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({});
          return;
        }
        resolve(parseExtPropsOutput(String(stdout || '')));
      },
    );
  });
}
