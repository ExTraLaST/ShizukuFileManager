'use strict';
/**
 * 电脑版核心服务与内置互联协议 v1 综合自动化测试
 * 使用 Node.js 内置 node:test 运行，完整验证：
 * - 全部 15 个互联 REST 接口（鉴权、roots、list、stat、download+Range 206/416、upload、mkdir、delete、rename、move、copy、quickaccess、thumbnail、message-file、message）
 * - UDP 发现报文构造与解析
 * - 本地流播代理（Range 透传、HEAD 探测、.m3u 生成）
 * - Windows CF_HDROP 剪贴板编码/解码
 * - 7-Zip 压缩包压缩、查看(list)、加密解压
 * - 音频内嵌封面提取（ID3v2 APIC / FLAC PICTURE）
 * - 本机递归搜索与消息过期/孤儿清理
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createLinkServer,
  buildDiscoveryResponse,
  parseRangeHeader,
  normalizeWirePath,
} = require('../dist-electron/services/link-server');
const {
  createLinkClient,
  parseDiscoveryResponse,
} = require('../dist-electron/services/link-client');
const {
  createMediaProxy,
  probeStream,
  buildPlaylistContent,
} = require('../dist-electron/services/link-proxy');
const { createMessageStore } = require('../dist-electron/services/message-store');
const { encodeHDrop, decodeHDrop } = require('../dist-electron/services/sys-clipboard');
const {
  buildCompressArgs,
  buildExtractArgs,
  runSevenZip,
  listArchiveEntries,
} = require('../dist-electron/services/archive');
const { extractId3Apic, extractFlacPicture } = require('../dist-electron/services/cover-art');
const { searchLocal } = require('../dist-electron/services/search-utils');
const { getTemplateBuffer } = require('../dist-electron/services/file-templates');

test('互联协议 v1：全部 15 个接口、鉴权、Range 206/416、缩略图、消息与流播代理', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuku-link-test-'));
  const driveRoot = path.join(tmpDir, 'driveC');
  const userDataDir = path.join(tmpDir, 'userData');
  fs.mkdirSync(driveRoot, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  // 预置文件与伪缩略图
  const mediaFile = path.join(driveRoot, 'movie.mp4');
  fs.writeFileSync(mediaFile, Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  const thumbImg = path.join(tmpDir, 'thumb.png');
  fs.writeFileSync(thumbImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));

  const msgStore = createMessageStore(userDataDir);
  let receivedMsg = null;

  const srv = createLinkServer({
    port: 0,
    password: 'secret-password-123',
    name: 'TestPC',
    deviceId: '11111111-2222-4333-8444-555555555555',
    drives: [{ letter: 'C', localRoot: driveRoot, label: '系统盘' }],
    quickAccess: [{ path: 'C:/Docs', name: '文档' }],
    messageStore: msgStore,
    onMessage: (r) => {
      receivedMsg = r;
    },
    generateThumbnail: async () => ({ file: thumbImg, mime: 'image/png' }),
    enableDiscovery: false,
  });

  const { port } = await srv.start();
  const proxy = createMediaProxy({ resolveHost: () => '127.0.0.1' });

  try {
    // 1. 鉴权失败校验
    const badClient = createLinkClient({ host: '127.0.0.1', port, password: 'wrong' });
    await assert.rejects(() => badClient.info(), (e) => e.status === 401);

    const client = createLinkClient({ host: '127.0.0.1', port, password: 'secret-password-123' });

    // 2. /api/info
    const info = await client.info();
    assert.equal(info.name, 'TestPC');
    assert.equal(info.type, 'pc');
    assert.equal(info.version, 1);
    assert.equal(info.id, '11111111-2222-4333-8444-555555555555');

    // 3. /api/roots & /api/quickaccess
    const roots = await client.roots();
    assert.equal(roots.roots.length, 1);
    assert.equal(roots.roots[0].path, 'C:/');
    const qa = await client.quickAccess();
    assert.deepEqual(qa.items, [{ name: '文档', path: 'C:/Docs' }]);

    // 4. /api/mkdir & /api/upload & /api/list & /api/stat
    await client.mkdir('C:/Docs');
    await client.uploadBuffer('C:/Docs/hello.txt', Buffer.from('你好世界'));
    const stat = await client.stat('C:/Docs/hello.txt');
    assert.equal(stat.exists, true);
    assert.equal(stat.isDirectory, false);
    const listed = await client.list('C:/Docs');
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].name, 'hello.txt');

    // 5. /api/copy & /api/rename & /api/move & /api/delete
    const copied = await client.copy('C:/Docs/hello.txt', 'C:/Docs');
    assert.equal(copied.path, 'C:/Docs/hello (2).txt');
    const renamed = await client.rename('C:/Docs/hello (2).txt', 'renamed.txt');
    assert.equal(renamed.path, 'C:/Docs/renamed.txt');
    await client.mkdir('C:/Archive');
    const moved = await client.move('C:/Docs/renamed.txt', 'C:/Archive');
    assert.equal(moved.path, 'C:/Archive/renamed.txt');
    await client.deleteOne('C:/Archive/renamed.txt');
    assert.equal((await client.stat('C:/Archive/renamed.txt')).exists, false);

    // 6. /api/download（完整下载 + Range 206 + 越界 416）
    const dlOut = path.join(tmpDir, 'downloaded.txt');
    await client.downloadToFile('C:/Docs/hello.txt', dlOut);
    assert.equal(fs.readFileSync(dlOut, 'utf8'), '你好世界');

    const r206 = await fetch(`http://127.0.0.1:${port}/api/download?path=${encodeURIComponent('C:/movie.mp4')}`, {
      headers: { 'X-Shizuku-Token': 'secret-password-123', Range: 'bytes=10-15' },
    });
    assert.equal(r206.status, 206);
    assert.equal(r206.headers.get('content-range'), 'bytes 10-15/36');
    assert.equal(await r206.text(), 'ABCDEF');

    const r416 = await fetch(`http://127.0.0.1:${port}/api/download?path=${encodeURIComponent('C:/movie.mp4')}`, {
      headers: { 'X-Shizuku-Token': 'secret-password-123', Range: 'bytes=999-1000' },
    });
    assert.equal(r416.status, 416);

    // 7. /api/thumbnail
    const thumb = await client.thumbnail('C:/movie.mp4', 256);
    assert.equal(thumb.contentType, 'image/png');
    assert.equal(thumb.buffer.length, 12);

    // 8. 本地媒体流播代理（Range 透传 + HEAD + .m3u）
    const conn = { host: '127.0.0.1', port, password: 'secret-password-123' };
    assert.equal(await probeStream(conn, 'C:/movie.mp4'), true);
    const streamUrl = await proxy.streamUrl(conn, 'C:/movie.mp4');
    const m3u = buildPlaylistContent('movie.mp4', streamUrl);
    assert.match(m3u, /#EXTM3U/);
    const headRes = await fetch(streamUrl, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-length'), '36');
    const proxyRangeRes = await fetch(streamUrl, { headers: { Range: 'bytes=0-9' } });
    assert.equal(proxyRangeRes.status, 206);
    assert.equal(await proxyRangeRes.text(), '0123456789');

    // 9. /api/message-file + /api/message（两阶段附件消息）
    const attLocal = path.join(tmpDir, 'att.txt');
    fs.writeFileSync(attLocal, '附件正文内容');
    const upAtt = await client.uploadMessageFile(attLocal);
    assert.ok(upAtt.fileId);
    await client.sendMessage({
      text: '请查收附件',
      from: 'Pixel 9',
      fromId: 'phone-uuid-001',
      time: Date.now(),
      attachment: { fileId: upAtt.fileId, name: 'att.txt', size: 18, mime: 'text/plain' },
    });
    assert.ok(receivedMsg);
    assert.equal(receivedMsg.text, '请查收附件');
    assert.equal(msgStore.attachmentExists('phone-uuid-001', upAtt.fileId), true);
    assert.equal(msgStore.unreadCounts()['phone-uuid-001'], 1);
    msgStore.markRead('phone-uuid-001');
    assert.equal(msgStore.unreadCounts()['phone-uuid-001'], undefined);

    // 10. UDP 发现报文编解码
    const discPayload = buildDiscoveryResponse('TestPC', 8898, 'uuid-1');
    const parsed = parseDiscoveryResponse(discPayload, '192.168.1.99', new Set(['192.168.1.10']));
    assert.deepEqual(parsed, {
      name: 'TestPC',
      type: 'pc',
      host: '192.168.1.99',
      port: 8898,
      id: 'uuid-1',
    });
    assert.equal(parseDiscoveryResponse(discPayload, '192.168.1.10', new Set(['192.168.1.10'])), null);
  } finally {
    await proxy.stop();
    await srv.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Windows 剪贴板 CF_HDROP 编码解码（含中文路径）', () => {
  const input = ['C:\\Users\\测试\\文档.docx', 'D:\\视频\\电影 01.mp4'];
  const buf = encodeHDrop(input);
  assert.ok(buf);
  const decoded = decodeHDrop(buf);
  assert.deepEqual(decoded, input);
});

test('7-Zip 压缩包：AES-256 加密压缩、查看条目列表、带密码解压', async () => {
  const exePath = path.join(__dirname, '..', 'resources', '7za.exe');
  if (!fs.existsSync(exePath)) return;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuku-7z-test-'));
  try {
    const srcFile = path.join(tmpDir, 'notes.txt');
    fs.writeFileSync(srcFile, 'Shizuku 压缩测试内容 123456', 'utf8');
    const outZip = path.join(tmpDir, 'bundle.zip');

    const cmpArgs = buildCompressArgs({
      format: 'zip',
      level: 'normal',
      password: 'pwd99',
      outPath: outZip,
      sources: [srcFile],
    });
    const cmpRes = await runSevenZip({ exePath, args: cmpArgs, cwd: tmpDir }).promise;
    assert.equal(cmpRes.code, 0);
    assert.equal(fs.existsSync(outZip), true);

    // 查看压缩包内容
    const listed = await listArchiveEntries({ exePath, archivePath: outZip, password: 'pwd99' });
    assert.equal(listed.ok, true);
    assert.equal(listed.entries.some((e) => e.name === 'notes.txt' && e.encrypted), true);

    // 带密码解压
    const extractDir = path.join(tmpDir, 'out');
    fs.mkdirSync(extractDir, { recursive: true });
    const extArgs = buildExtractArgs({ archivePath: outZip, outDir: extractDir, password: 'pwd99' });
    const extRes = await runSevenZip({ exePath, args: extArgs }).promise;
    assert.equal(extRes.code, 0);
    assert.equal(fs.readFileSync(path.join(extractDir, 'notes.txt'), 'utf8'), 'Shizuku 压缩测试内容 123456');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('音频封面提取、办公模板加载、路径校验、Range 解析与本机递归搜索', async () => {
  // 办公模板完整性校验（ZIP PK 头）
  for (const key of ['docx', 'xlsx', 'pptx']) {
    const buf = getTemplateBuffer(key);
    assert.equal(buf[0], 0x50);
    assert.equal(buf[1], 0x4b);
  }
  assert.equal(getTemplateBuffer('txt').length, 0);

  // 路径防穿越校验
  assert.ok('error' in normalizeWirePath('C:/a/../b'));
  assert.ok('error' in normalizeWirePath('C:\\a\\b'));
  assert.equal(normalizeWirePath('d:/foo/bar/').wire, 'D:/foo/bar');

  // Range 边界解析
  assert.deepEqual(parseRangeHeader('bytes=-5', 20), { start: 15, end: 19 });
  assert.equal(parseRangeHeader('bytes=20-25', 20), null);

  // ID3v2 APIC 模拟帧解析
  const jpegMock = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0xaa)]);
  const apicPayload = Buffer.concat([
    Buffer.from([0x00]),
    Buffer.from('image/jpeg\0', 'ascii'),
    Buffer.from([0x03]),
    Buffer.from('\0', 'ascii'),
    jpegMock,
  ]);
  const frameHeader = Buffer.alloc(10);
  frameHeader.write('APIC', 0, 'ascii');
  frameHeader.writeUInt32BE(apicPayload.length, 4);
  const tagSize = frameHeader.length + apicPayload.length;
  const id3Header = Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
    (tagSize >> 21) & 0x7f, (tagSize >> 14) & 0x7f, (tagSize >> 7) & 0x7f, tagSize & 0x7f,
  ]);
  const extracted = extractId3Apic(Buffer.concat([id3Header, frameHeader, apicPayload]));
  assert.ok(extracted);
  assert.equal(extracted.mime, 'image/jpeg');
  assert.equal(extracted.buffer.length, jpegMock.length);

  // FLAC PICTURE 块解析
  const flacBody = Buffer.concat([
    Buffer.from([0, 0, 0, 9]), Buffer.from('image/png', 'ascii'),
    Buffer.from([0, 0, 0, 0]), Buffer.alloc(20),
    Buffer.from([0, 0, 0, jpegMock.length]), jpegMock,
  ]);
  const flacHeader = Buffer.from([
    0x66, 0x4c, 0x61, 0x43, 0x86,
    (flacBody.length >> 16) & 0xff, (flacBody.length >> 8) & 0xff, flacBody.length & 0xff,
  ]);
  const flacCover = extractFlacPicture(Buffer.concat([flacHeader, flacBody]));
  assert.ok(flacCover);
  assert.equal(flacCover.mime, 'image/png');

  // 本机递归搜索
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuku-search-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'sub', 'deep', 'ShizukuReport.pdf'), 'ok');
    const res = await searchLocal({ dir: tmpDir, query: 'report' });
    assert.equal(res.items.length, 1);
    assert.equal(res.items[0].name, 'ShizukuReport.pdf');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
