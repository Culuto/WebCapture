import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';

export const EXPORT_FORMAT = 'webcapture-archive';
export const EXPORT_VERSION = 1;
const META_NAME = 'webcapture-export.json';
const LEGACY_META_NAMES = new Set(['sitevault-export.json']);
const LEGACY_EXPORT_FORMATS = new Set(['sitevault-archive']);
const ARCHIVE_PREFIX = 'archive/';
const EXCLUDED_FILES = new Set(['storage-summary.json', 'diff-summary.json']);
const SAFE_RELATIVE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const TAR_BLOCK = 512;
const ARCHIVE_ID = /^archive_[a-z0-9_]+$/i;

async function write(out, chunk) {
  if (!out.write(chunk)) await once(out, 'drain');
}

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

export function tarHeader(name, size, mtime = Math.floor(Date.now() / 1000)) {
  const header = Buffer.alloc(TAR_BLOCK);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const index = name.lastIndexOf('/', name.length - 1);
    prefix = name.slice(0, index);
    base = name.slice(index + 1);
    if (index < 0 || Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`書き出せない長いファイル名です: ${name}`);
  }
  header.write(base, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  if (size < 0o77777777777) header.write(octal(size, 12), 124, 12, 'ascii');
  else {
    header[124] = 0x80;
    let remaining = BigInt(size);
    for (let index = 135; index > 124; index -= 1) { header[index] = Number(remaining & 0xffn); remaining >>= 8n; }
  }
  header.write(octal(mtime, 12), 136, 12, 'ascii');
  header.fill(0x20, 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function parseTarSize(header) {
  if (header[124] & 0x80) {
    let value = 0n;
    for (let index = 125; index < 136; index += 1) value = (value << 8n) | BigInt(header[index]);
    return Number(value);
  }
  return parseInt(header.toString('ascii', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
}

async function listArchiveFiles(root) {
  const files = [];
  const walk = async (dir, relative) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else if (entry.isFile() && !EXCLUDED_FILES.has(rel) && !/^blobs\/incoming-/.test(rel) && !rel.endsWith('.tmp')) files.push(rel);
    }
  };
  await walk(root, '');
  const priority = (name) => name === 'manifest.json' ? 0 : name.startsWith('blobs/') ? 2 : 1;
  return files.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));
}

export async function exportWebCapture(store, archiveId, out, { appVersion = '' } = {}) {
  const archive = store.getArchive(archiveId);
  const root = store.archiveRoot(archiveId);
  const manifest = await store.readManifest(archiveId);
  if (!archive || !manifest) throw Object.assign(new Error('保存済みサイトが見つかりません。'), { code: 'NOT_FOUND', status: 404 });
  const { jobId, ...record } = archive;
  const meta = Buffer.from(JSON.stringify({
    format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: new Date().toISOString(), appVersion,
    archive: record, sharedPagesExcluded: (manifest.sharedPages || []).length
  }, null, 2));
  await write(out, tarHeader(META_NAME, meta.length));
  await write(out, meta);
  await write(out, Buffer.alloc((TAR_BLOCK - (meta.length % TAR_BLOCK)) % TAR_BLOCK));
  for (const relative of await listArchiveFiles(root)) {
    const file = path.join(root, relative);
    const stat = await fsp.stat(file);
    await write(out, tarHeader(ARCHIVE_PREFIX + relative, stat.size, Math.floor(stat.mtimeMs / 1000)));
    for await (const chunk of fs.createReadStream(file)) await write(out, chunk);
    await write(out, Buffer.alloc((TAR_BLOCK - (stat.size % TAR_BLOCK)) % TAR_BLOCK));
  }
  await write(out, Buffer.alloc(TAR_BLOCK * 2));
}

class TarReader {
  constructor(input) {
    this.iterator = input[Symbol.asyncIterator]();
    this.buffer = Buffer.alloc(0);
    this.ended = false;
  }
  async fill(size) {
    while (this.buffer.length < size && !this.ended) {
      const { value, done } = await this.iterator.next();
      if (done) { this.ended = true; break; }
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, value]) : Buffer.from(value);
    }
    return this.buffer.length >= size;
  }
  async take(size) {
    if (!await this.fill(size)) throw new Error('読み込むファイルが途中で終わっています。');
    const chunk = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return chunk;
  }
  async *stream(size) {
    let remaining = size;
    while (remaining > 0) {
      if (!this.buffer.length && !await this.fill(1)) throw new Error('読み込むファイルが途中で終わっています。');
      const chunk = this.buffer.subarray(0, Math.min(remaining, this.buffer.length));
      this.buffer = this.buffer.subarray(chunk.length);
      remaining -= chunk.length;
      yield chunk;
    }
  }
}

export async function importWebCapture(store, input, { importsRoot, createArchiveId } = {}) {
  const reader = new TarReader(input);
  const staging = path.join(importsRoot, `import-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.mkdir(staging, { recursive: true });
  let meta = null;
  let fileCount = 0;
  try {
    while (true) {
      const header = await reader.take(TAR_BLOCK);
      if (header.every((byte) => byte === 0)) break;
      const name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/s, '');
      const fullName = prefix ? `${prefix}/${name}` : name;
      const type = String.fromCharCode(header[156] || 48);
      const size = parseTarSize(header);
      const padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
      if (type === '5') { if (padding) await reader.take(padding); continue; }
      if (type !== '0') throw new Error('WebCaptureの書き出しファイルではありません（対応していない項目が含まれています）。');
      if (!meta) {
        if ((fullName !== META_NAME && !LEGACY_META_NAMES.has(fullName)) || size > 10 * 1024 * 1024) throw new Error('WebCaptureの書き出しファイルではありません。');
        meta = JSON.parse((await reader.take(size)).toString('utf8'));
        if ((meta.format !== EXPORT_FORMAT && !LEGACY_EXPORT_FORMATS.has(meta.format)) || meta.version !== EXPORT_VERSION) throw new Error('この形式の書き出しファイルには対応していません。');
      } else {
        if (!fullName.startsWith(ARCHIVE_PREFIX)) throw new Error(`想定外のファイルが含まれています: ${fullName}`);
        const relative = fullName.slice(ARCHIVE_PREFIX.length);
        if (!SAFE_RELATIVE.test(relative) || relative.split('/').some((part) => part === '..' || part === '.')) throw new Error(`安全でないファイル名が含まれています: ${relative}`);
        const target = path.join(staging, ...relative.split('/'));
        if (!target.startsWith(staging + path.sep)) throw new Error('安全でないファイル名が含まれています。');
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await pipeline(reader.stream(size), fs.createWriteStream(target, { flags: 'wx' }));
        fileCount += 1;
      }
      if (padding) await reader.take(padding);
    }
    if (!meta) throw new Error('WebCaptureの書き出しファイルではありません。');
    const manifestFile = path.join(staging, 'manifest.json');
    const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));
    if (!Array.isArray(manifest.pages) || typeof manifest.resources !== 'object') throw new Error('アーカイブの中身が壊れています。');
    const wanted = String(meta.archive?.id || manifest.id || '');
    const archiveId = ARCHIVE_ID.test(wanted) && !store.getArchive(wanted) && !fs.existsSync(store.archiveRoot(wanted)) ? wanted : createArchiveId();
    manifest.id = archiveId;
    await fsp.writeFile(manifestFile, JSON.stringify(manifest));
    await fsp.mkdir(path.dirname(store.archiveRoot(archiveId)), { recursive: true });
    await fsp.rename(staging, store.archiveRoot(archiveId));
    const source = meta.archive || {};
    const record = {
      id: archiveId, startUrl: source.startUrl || manifest.startUrl, title: source.title || manifest.pages[0]?.title || '',
      status: source.status || manifest.status || 'complete', pages: manifest.pages.length, resources: Object.keys(manifest.resources || {}).length,
      bytes: Number(source.bytes) || 0, errors: Number(source.errors) || 0, savedAt: source.savedAt || manifest.completedAt || new Date().toISOString(),
      engine: source.engine || manifest.engine || 'HTTP', partial: Boolean(source.partial), quality: source.quality || manifest.quality || null,
      ...(source.loggedIn ? { loggedIn: true } : {}), importedAt: new Date().toISOString(), importedFrom: wanted || null
    };
    await store.addArchive(record);
    return { archive: record, fileCount, sharedPagesExcluded: Number(meta.sharedPagesExcluded) || 0 };
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

const STATUS_TEXT = { 200: 'OK', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' };

function httpHead(status, headers = {}, size = 0, mimeType = '') {
  const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] || 'OK'}`];
  let hasType = false;
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (['content-encoding', 'transfer-encoding', 'content-length', 'set-cookie'].includes(lower)) continue;
    if (lower === 'content-type') hasType = true;
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${String(item).replace(/[\r\n]+/g, ' ')}`);
  }
  if (!hasType && mimeType) lines.push(`Content-Type: ${mimeType}`);
  lines.push(`Content-Length: ${size}`);
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n');
}

function warcHead(headers, blockLength) {
  const lines = ['WARC/1.1', ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), `Content-Length: ${blockLength}`];
  return Buffer.from(lines.join('\r\n') + '\r\n\r\n');
}

function timestamp14(value) {
  const date = new Date(value || Date.now());
  return (Number.isNaN(date.getTime()) ? new Date() : date).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function surtKey(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\d*\./, '');
    const labels = host.split('.').reverse().join(',');
    const port = url.port && !['80', '443'].includes(url.port) ? `:${url.port}` : '';
    const params = [...url.searchParams].sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
    const query = params.length ? `?${params.map(([key, item]) => `${key}=${item}`).join('&').toLowerCase()}` : '';
    return `${labels}${port})${url.pathname.toLowerCase() || '/'}${query}`;
  } catch { return value; }
}

async function writeWarcMember(out, warcHeaders, parts, blockLength, state) {
  const gzip = zlib.createGzip({ level: 1 });
  let compressed = 0;
  gzip.on('data', (chunk) => { compressed += chunk.length; state.hash.update(chunk); state.crc = zlib.crc32(chunk, state.crc); });
  const done = new Promise((resolve, reject) => { gzip.on('end', resolve); gzip.on('error', reject); });
  gzip.pipe(out, { end: false });
  const pushChunk = async (chunk) => { if (!gzip.write(chunk)) await once(gzip, 'drain'); };
  await pushChunk(warcHead(warcHeaders, blockLength));
  for (const part of parts) {
    if (Buffer.isBuffer(part)) await pushChunk(part);
    else for await (const chunk of fs.createReadStream(part.file)) await pushChunk(chunk);
  }
  await pushChunk(Buffer.from('\r\n\r\n'));
  gzip.end();
  await done;
  const offset = state.offset;
  state.offset += compressed;
  return { offset, length: compressed };
}

async function buildWacz(store, archiveId, workDir) {
  const root = store.archiveRoot(archiveId);
  const manifest = await store.readManifest(archiveId);
  const warcFile = path.join(workDir, 'data.warc.gz');
  const out = fs.createWriteStream(warcFile);
  const state = { offset: 0, hash: crypto.createHash('sha256'), crc: 0 };
  const cdx = [];
  const add = async (url, capturedAt, status, headers, mimeType, body) => {
    const size = Buffer.isBuffer(body) ? body.length : body.size;
    const head = httpHead(status, headers, size, mimeType);
    const position = await writeWarcMember(out, {
      'WARC-Type': 'response', 'WARC-Target-URI': url, 'WARC-Date': new Date(capturedAt || Date.now()).toISOString(),
      'WARC-Record-ID': `<urn:uuid:${crypto.randomUUID()}>`, 'Content-Type': 'application/http; msgtype=response'
    }, [head, body], head.length + size, state);
    cdx.push(`${surtKey(url)} ${timestamp14(capturedAt)} ${JSON.stringify({ url, mime: String(mimeType || '').split(';')[0], status: String(status), length: String(position.length), offset: String(position.offset), filename: 'data.warc.gz' })}`);
  };
  const pages = [];
  for (const page of manifest.pages || []) {
    if (!page.html) continue;
    const file = path.join(root, page.html);
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    await add(page.url, page.capturedAt, 200, { 'Content-Type': 'text/html; charset=utf-8' }, 'text/html', { file, size: stat.size });
    if (page.requestedUrl && page.requestedUrl !== page.url) await add(page.requestedUrl, page.capturedAt, 302, { Location: page.url }, 'text/html', Buffer.alloc(0));
    pages.push({ id: crypto.randomUUID(), url: page.url, ts: new Date(page.capturedAt || Date.now()).toISOString(), title: page.title || '' });
  }
  const pageUrls = new Set((manifest.pages || []).map((page) => page.url));
  for (const resource of Object.values(manifest.resources || {})) {
    if (!resource?.file || pageUrls.has(resource.url)) continue;
    const file = path.join(root, resource.file);
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    await add(resource.url, resource.capturedAt, Number(resource.status) || 200, resource.headers || {}, resource.mimeType || '', { file, size: stat.size });
  }
  for (const [alias, target] of Object.entries(manifest.resourceAliases || {})) {
    if (manifest.resources?.[target] && !manifest.resources[alias]) await add(alias, manifest.resources[target].capturedAt, 302, { Location: target }, 'text/html', Buffer.alloc(0));
  }
  out.end();
  await once(out, 'finish');
  const warcStat = await fsp.stat(warcFile);
  const pagesJsonl = Buffer.from([JSON.stringify({ format: 'json-pages-1.0', id: 'pages', title: 'All Pages' }), ...pages.map((page) => JSON.stringify(page))].join('\n') + '\n');
  const index = Buffer.from(cdx.sort().join('\n') + '\n');
  const sha = (buffer) => `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
  const archive = store.getArchive(archiveId) || {};
  const datapackage = Buffer.from(JSON.stringify({
    profile: 'data-package', wacz_version: '1.1.1', title: archive.title || manifest.startUrl, created: new Date().toISOString(),
    software: 'WebCapture', mainPageUrl: manifest.startUrl, mainPageDate: new Date(manifest.pages?.[0]?.capturedAt || Date.now()).toISOString(),
    resources: [
      { name: 'data.warc.gz', path: 'archive/data.warc.gz', hash: `sha256:${state.hash.digest('hex')}`, bytes: warcStat.size },
      { name: 'pages.jsonl', path: 'pages/pages.jsonl', hash: sha(pagesJsonl), bytes: pagesJsonl.length },
      { name: 'index.cdxj', path: 'indexes/index.cdxj', hash: sha(index), bytes: index.length }
    ]
  }, null, 2));
  return [
    { name: 'datapackage.json', data: datapackage },
    { name: 'pages/pages.jsonl', data: pagesJsonl },
    { name: 'indexes/index.cdxj', data: index },
    { name: 'archive/data.warc.gz', file: warcFile, size: warcStat.size, crc: state.crc }
  ];
}

function zipEntryHeaders(entry, offset) {
  const name = Buffer.from(entry.name, 'utf8');
  const size = entry.data ? entry.data.length : entry.size;
  const crc = entry.data ? zlib.crc32(entry.data) : entry.crc;
  const zip64 = size >= 0xffffffff || offset >= 0xffffffff;
  const localExtra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
  if (zip64) { localExtra.writeUInt16LE(0x0001, 0); localExtra.writeUInt16LE(16, 2); localExtra.writeBigUInt64LE(BigInt(size), 4); localExtra.writeBigUInt64LE(BigInt(size), 12); }
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(zip64 ? 45 : 20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x21, 12);
  local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(zip64 ? 0xffffffff : size, 18);
  local.writeUInt32LE(zip64 ? 0xffffffff : size, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(localExtra.length, 28);
  const centralExtra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
  if (zip64) { centralExtra.writeUInt16LE(0x0001, 0); centralExtra.writeUInt16LE(24, 2); centralExtra.writeBigUInt64LE(BigInt(size), 4); centralExtra.writeBigUInt64LE(BigInt(size), 12); centralExtra.writeBigUInt64LE(BigInt(offset), 20); }
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(45, 4);
  central.writeUInt16LE(zip64 ? 45 : 20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(crc >>> 0, 16);
  central.writeUInt32LE(zip64 ? 0xffffffff : size, 20);
  central.writeUInt32LE(zip64 ? 0xffffffff : size, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(centralExtra.length, 30);
  central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
  return { local: Buffer.concat([local, name, localExtra]), central: Buffer.concat([central, name, centralExtra]), size };
}

export async function writeZip(out, entries) {
  let offset = 0;
  const centrals = [];
  for (const entry of entries) {
    const { local, central, size } = zipEntryHeaders(entry, offset);
    await write(out, local);
    if (entry.data) await write(out, entry.data);
    else for await (const chunk of fs.createReadStream(entry.file)) await write(out, chunk);
    centrals.push(central);
    offset += local.length + size;
  }
  const directory = Buffer.concat(centrals);
  await write(out, directory);
  const needs64 = offset >= 0xffffffff || entries.length >= 0xffff;
  if (needs64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    await write(out, Buffer.concat([record, locator]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  end.writeUInt32LE(Math.min(directory.length, 0xffffffff), 12);
  end.writeUInt32LE(needs64 ? 0xffffffff : offset, 16);
  await write(out, end);
}

export async function exportWacz(store, archiveId, out, { workRoot }) {
  if (!store.getArchive(archiveId) || !await store.readManifest(archiveId)) throw Object.assign(new Error('保存済みサイトが見つかりません。'), { code: 'NOT_FOUND', status: 404 });
  const workDir = path.join(workRoot, `wacz-${crypto.randomBytes(8).toString('hex')}`);
  await fsp.mkdir(workDir, { recursive: true });
  try {
    const entries = await buildWacz(store, archiveId, workDir);
    await writeZip(out, entries);
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function exportFileName(archive, format) {
  const base = String(archive?.title || archive?.startUrl || archive?.id || 'archive').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'archive';
  const date = new Date(archive?.savedAt || Date.now()).toISOString().slice(0, 10);
  return `${base}-${date}.${format === 'wacz' ? 'wacz' : 'webcapture'}`;
}
