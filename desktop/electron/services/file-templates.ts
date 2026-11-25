/**
 * 新建办公与文本文档模板管理
 * 支持 Word (.docx)、Excel (.xlsx)、PowerPoint (.pptx) 合法 OOXML 模板以及空 .txt
 */
import fs from 'fs';
import path from 'path';

export const TEMPLATE_FILES: Record<string, string> = {
  docx: 'word.docx',
  xlsx: 'excel.xlsx',
  pptx: 'powerpoint.pptx',
};

const cache = new Map<string, Buffer>();

function resolveTemplatesDir(): string {
  const candidates = [
    path.join(process.resourcesPath || '', 'templates'),
    path.join(__dirname, '..', '..', 'resources', 'templates'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return candidates[1];
}

export function getTemplateBuffer(key: string): Buffer {
  if (!key || key === 'txt') return Buffer.alloc(0);
  const hit = cache.get(key);
  if (hit) return hit;
  const file = TEMPLATE_FILES[key];
  if (!file) throw new Error(`未知的模板类型：${key}`);
  const buf = fs.readFileSync(path.join(resolveTemplatesDir(), file));
  cache.set(key, buf);
  return buf;
}
