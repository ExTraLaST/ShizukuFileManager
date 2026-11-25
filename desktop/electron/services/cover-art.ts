/**
 * 音频内嵌封面提取器（Shell 缩略图的兜底方案）
 * 支持 MP3 (ID3v2 APIC)、FLAC (PICTURE block 6)、M4A/MP4 (moov/udta/meta/ilst/covr)
 * 仅读取文件头最多 8MB，按文件头魔数识别格式。
 */
import fs from 'fs';

export const HEAD_READ_MAX = 8 * 1024 * 1024;

function readHead(filePath: string): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, HEAD_READ_MAX);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function synchsafe(buf: Buffer, off: number): number {
  return (
    ((buf[off] & 0x7f) << 21) |
    ((buf[off + 1] & 0x7f) << 14) |
    ((buf[off + 2] & 0x7f) << 7) |
    (buf[off + 3] & 0x7f)
  );
}

export interface CoverArtResult {
  buffer: Buffer;
  mime: string;
}

export function extractId3Apic(buf: Buffer): CoverArtResult | null {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return null;
  const ver = buf[3];
  if (ver < 3) return null;
  const tagSize = synchsafe(buf, 6);
  const tagEnd = Math.min(10 + tagSize, buf.length);
  let off = 10;
  while (off + 10 <= tagEnd) {
    const id = buf.toString('ascii', off, off + 4);
    if (id === '\0\0\0\0') break;
    const size = ver >= 4 ? synchsafe(buf, off + 4) : buf.readUInt32BE(off + 4);
    const dataStart = off + 10;
    const dataEnd = Math.min(dataStart + size, tagEnd);
    if (id === 'APIC' && dataEnd > dataStart + 1) {
      let p = dataStart + 1;
      const mimeEnd = buf.indexOf(0, p);
      if (mimeEnd < 0 || mimeEnd >= dataEnd) return null;
      const mime = buf.toString('ascii', p, mimeEnd) || 'image/jpeg';
      p = mimeEnd + 2;
      const descEnd = buf.indexOf(0, p);
      if (descEnd < 0 || descEnd >= dataEnd) return null;
      let imgStart = descEnd + 1;
      if (buf[imgStart] === 0 && imgStart + 1 < dataEnd) imgStart++;
      if (imgStart >= dataEnd) return null;
      const image = buf.subarray(imgStart, dataEnd);
      if (image.length < 16) return null;
      return { buffer: Buffer.from(image), mime };
    }
    if (size <= 0) break;
    off = dataStart + size;
  }
  return null;
}

export function extractFlacPicture(buf: Buffer): CoverArtResult | null {
  if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'fLaC') return null;
  let off = 4;
  while (off + 4 <= buf.length) {
    const type = buf[off] & 0x7f;
    const last = (buf[off] & 0x80) !== 0;
    const len = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const start = off + 4;
    const end = Math.min(start + len, buf.length);
    if (type === 6 && end > start + 32) {
      let p = start;
      const mimeLen = buf.readUInt32BE(p);
      p += 4;
      if (p + mimeLen > end) return null;
      const mime = buf.toString('ascii', p, p + mimeLen) || 'image/jpeg';
      p += mimeLen;
      if (p + 4 > end) return null;
      const descLen = buf.readUInt32BE(p);
      p += 4 + descLen + 20;
      if (p + 4 > end) return null;
      const imgLen = buf.readUInt32BE(p);
      p += 4;
      if (p + imgLen > end || imgLen < 16) return null;
      return { buffer: Buffer.from(buf.subarray(p, p + imgLen)), mime };
    }
    if (last) break;
    off = start + len;
  }
  return null;
}

function findAtom(
  buf: Buffer,
  start: number,
  end: number,
  wanted: string,
): { start: number; end: number } | null {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    let headerLen = 8;
    if (size === 1 && off + 16 <= end) {
      size = Number(buf.readBigUInt64BE(off + 8));
      headerLen = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < headerLen) break;
    const atomEnd = Math.min(off + size, end);
    if (type === wanted) return { start: off + headerLen, end: atomEnd };
    off = atomEnd;
  }
  return null;
}

export function extractMp4Covr(buf: Buffer): CoverArtResult | null {
  if (buf.length < 8) return null;
  const moov = findAtom(buf, 0, buf.length, 'moov');
  if (!moov) return null;
  const udta = findAtom(buf, moov.start, moov.end, 'udta');
  if (!udta) return null;
  const meta = findAtom(buf, udta.start, udta.end, 'meta');
  if (!meta || meta.end - meta.start < 4) return null;
  const ilst = findAtom(buf, meta.start + 4, meta.end, 'ilst');
  if (!ilst) return null;
  const covr = findAtom(buf, ilst.start, ilst.end, 'covr');
  if (!covr) return null;
  const data = findAtom(buf, covr.start, covr.end, 'data');
  if (!data || data.end - data.start < 8) return null;
  const kind = buf.readUInt32BE(data.start);
  const mime = kind === 14 ? 'image/png' : 'image/jpeg';
  const image = buf.subarray(data.start + 8, data.end);
  if (image.length < 16) return null;
  return { buffer: Buffer.from(image), mime };
}

export function extractCoverArt(filePath: string): CoverArtResult | null {
  let buf: Buffer;
  try {
    buf = readHead(filePath);
  } catch {
    return null;
  }
  if (buf.length < 8) return null;
  if (buf.toString('ascii', 0, 3) === 'ID3') return extractId3Apic(buf);
  if (buf.toString('ascii', 0, 4) === 'fLaC') return extractFlacPicture(buf);
  if (buf.toString('ascii', 4, 8) === 'ftyp') return extractMp4Covr(buf);
  return null;
}

export function extForMime(mime: string): string {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/bmp') return '.bmp';
  return '.jpg';
}
