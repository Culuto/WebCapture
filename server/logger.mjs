import './env-compat.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logRoot = process.env.WEBCAPTURE_LOG_ROOT ? path.resolve(process.env.WEBCAPTURE_LOG_ROOT) : path.join(projectRoot, 'runtime', 'logs');
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_LOG_FILES = 10;
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SAFE_QUERY_KEYS = new Set(['width', 'page', 'variant', 'v']);
const sessionHashKey = crypto.randomBytes(32);
let writeQueue = Promise.resolve();
let sequence = 0;
let activeFile = '';
let activeDay = '';
let activeSize = 0;
let rotation = 0;

export function safeUrl(value) {
  const input = String(value || '');
  // Avoid sanitizing an already-sanitized URL a second time when callers use
  // safeUrl() before passing an event through the logger's general scrubber.
  if (/^https?:\/\/[^/]+\/\[segments:\d+;ext:[^\]]+\](?:\?keys=[^#]*)?#id=[a-f0-9]{16}$/i.test(input)) return input;
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    const query = [...new Set([...url.searchParams.keys()].map((key) => SAFE_QUERY_KEYS.has(key.toLowerCase()) ? key : '[redacted-key]'))].sort();
    const segmentCount = url.pathname.split('/').filter(Boolean).length;
    const extension = path.extname(url.pathname).slice(0, 12).toLowerCase() || 'none';
    const hash = crypto.createHmac('sha256', sessionHashKey).update(url.href).digest('hex').slice(0, 16);
    return `${url.origin}/[segments:${segmentCount};ext:${extension}]${query.length ? `?keys=${query.join(',')}` : ''}#id=${hash}`;
  } catch {
    return input.slice(0, 300).replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email-redacted]');
  }
}

function clean(value, key = '', depth = 0) {
  if (depth > 5) return '[depth-limited]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/url|href|src|target/i.test(key) || /^https?:\/\//i.test(value)) return safeUrl(value);
    if (/token|secret|password|cookie|authorization|body|value|input/i.test(key)) return '[redacted]';
    return value.slice(0, 1000)
      .replace(/https?:\/\/[^\s"']+/gi, '[url-redacted]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email-redacted]')
      .replace(/[a-z]:\\Users\\[^\\\s"']+/gi, '[user-profile]')
      .replace(/\/(?:home|Users)\/[^/\s"']+/g, '[user-profile]');
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => clean(item, key, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 200)) output[childKey] = clean(childValue, childKey, depth + 1);
    return output;
  }
  return String(value).slice(0, 300);
}

export function redactDiagnosticData(value) {
  return clean(value);
}

async function targetFile() {
  await fs.mkdir(logRoot, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  if (!activeFile || activeDay !== day) {
    const now = Date.now();
    const candidates = [];
    for (const name of (await fs.readdir(logRoot)).filter((item) => item.endsWith('.jsonl'))) {
      const file = path.join(logRoot, name);
      try { candidates.push({ file, modified: (await fs.stat(file)).mtimeMs }); } catch {}
    }
    candidates.sort((a, b) => b.modified - a.modified);
    for (const item of candidates.filter((entry, index) => index >= MAX_LOG_FILES || now - entry.modified > MAX_LOG_AGE_MS)) {
      try { await fs.rm(item.file, { force: true }); } catch {}
    }
    activeDay = day; rotation = 0; activeFile = path.join(logRoot, `webcapture-${day}.jsonl`);
    try { activeSize = (await fs.stat(activeFile)).size; } catch { activeSize = 0; }
  }
  if (activeSize >= MAX_LOG_BYTES) {
    rotation += 1; activeFile = path.join(logRoot, `webcapture-${day}-${rotation}.jsonl`); activeSize = 0;
  }
  return activeFile;
}

export function logEvent(level, component, event, data = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    sequence: ++sequence,
    level,
    component,
    event,
    data: clean(data)
  };
  writeQueue = writeQueue.then(async () => {
    const file = await targetFile();
    const line = `${JSON.stringify(record)}\n`;
    await fs.appendFile(file, line, 'utf8');
    activeSize += Buffer.byteLength(line);
  }).catch(() => {});
  return record;
}

async function readTailLines(file, wanted) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const chunks = [];
    let position = size;
    let newlines = 0;
    while (position > 0 && newlines <= wanted) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, position);
      chunks.unshift(buffer);
      for (const byte of buffer) if (byte === 10) newlines += 1;
    }
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(Boolean).slice(-wanted);
  } finally {
    await handle.close();
  }
}

export async function readRecentLogs(limit = 500) {
  await writeQueue;
  await fs.mkdir(logRoot, { recursive: true });
  const wanted = Math.min(5000, Math.max(1, Number(limit) || 500));
  const entries = await Promise.all((await fs.readdir(logRoot)).filter((name) => name.endsWith('.jsonl')).map(async (name) => {
    try { return { name, modified: (await fs.stat(path.join(logRoot, name))).mtimeMs }; } catch { return null; }
  }));
  const files = orderRecentLogFiles(entries.filter(Boolean));
  const lines = [];
  for (const file of files) {
    const remaining = wanted - lines.length;
    if (remaining <= 0) break;
    lines.unshift(...await readTailLines(path.join(logRoot, file), remaining));
  }
  return lines.slice(-wanted).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function orderRecentLogFiles(entries, limit = MAX_LOG_FILES) {
  return [...entries].sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name)).slice(0, limit).map(item => item.name);
}

export async function waitForLogs() { await writeQueue; }

export function diagnosticLogRoot() { return logRoot; }
