import fs from 'node:fs/promises';
import path from 'node:path';
import { stableDocumentKey } from './policy.mjs';

const DIFF_FILE = 'diff-summary.json';
const DIFF_VERSION = 1;
const MAX_DIFF_LINES = 3000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToLines(html = '') {
  const text = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:title|head|p|div|li|tr|h[1-6]|section|article|header|footer|nav|main|aside|dd|dt|blockquote|pre|table|ul|ol|figure|figcaption|summary|details|option)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return ENTITIES[name.toLowerCase()] ?? match;
    });
  return text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function diffLines(before = [], after = [], limit = MAX_DIFF_LINES) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore -= 1; endAfter -= 1; }
  const head = before.slice(0, start).map((text) => ({ type: 'same', text }));
  const tail = before.slice(endBefore).map((text) => ({ type: 'same', text }));
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  let middle;
  if (a.length > limit || b.length > limit) {
    middle = [...a.map((text) => ({ type: 'remove', text })), ...b.map((text) => ({ type: 'add', text }))];
  } else {
    const width = b.length + 1;
    const table = new Uint16Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { middle.push({ type: 'same', text: a[i] }); i += 1; j += 1; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) { middle.push({ type: 'remove', text: a[i] }); i += 1; }
      else { middle.push({ type: 'add', text: b[j] }); j += 1; }
    }
    while (i < a.length) middle.push({ type: 'remove', text: a[i++] });
    while (j < b.length) middle.push({ type: 'add', text: b[j++] });
  }
  return [...head, ...middle, ...tail];
}

function pageKey(page) {
  return stableDocumentKey(page.requestedUrl || page.url);
}

function indexPages(manifest) {
  const map = new Map();
  for (const page of manifest?.pages || []) {
    if (!page.html) continue;
    const key = pageKey(page);
    if (!map.has(key)) map.set(key, page);
  }
  return map;
}

async function pageLines(store, archiveId, page) {
  try { return htmlToLines(await fs.readFile(path.join(store.archiveRoot(archiveId), page.html), 'utf8')); } catch { return []; }
}

async function manifestSignature(store, archiveId) {
  try { const stat = await fs.stat(store.manifestFile(archiveId)); return `${stat.mtimeMs}:${stat.size}`; } catch { return ''; }
}

export async function archiveDiff(store, archiveId, previousArchiveId) {
  const signature = `${previousArchiveId}|${await manifestSignature(store, archiveId)}|${await manifestSignature(store, previousArchiveId)}`;
  const cacheFile = path.join(store.archiveRoot(archiveId), DIFF_FILE);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (cached.version === DIFF_VERSION && cached.signature === signature) return cached;
  } catch {}
  const [current, previous] = await Promise.all([store.readManifest(archiveId), store.readManifest(previousArchiveId)]);
  if (!current || !previous) throw Object.assign(new Error('比べる前回のアーカイブが見つかりません。'), { code: 'PREVIOUS_NOT_FOUND', status: 404 });
  const now = indexPages(current);
  const before = indexPages(previous);
  const added = [];
  const removed = [];
  const changed = [];
  let unchanged = 0;
  for (const [key, page] of now) {
    const old = before.get(key);
    if (!old) { added.push({ url: page.url, title: page.title || '' }); continue; }
    if (old.html === page.html) { unchanged += 1; continue; }
    const [a, b] = await Promise.all([pageLines(store, previousArchiveId, old), pageLines(store, archiveId, page)]);
    if (a.join('\n') === b.join('\n')) { unchanged += 1; continue; }
    const ops = diffLines(a, b);
    changed.push({ url: page.url, title: page.title || '', added: ops.filter((op) => op.type === 'add').length, removed: ops.filter((op) => op.type === 'remove').length });
  }
  for (const [key, page] of before) if (!now.has(key)) removed.push({ url: page.url, title: page.title || '' });
  changed.sort((x, y) => (y.added + y.removed) - (x.added + x.removed));
  const summary = { version: DIFF_VERSION, signature, archiveId, previousArchiveId, added, removed, changed, unchangedCount: unchanged, computedAt: new Date().toISOString() };
  await fs.writeFile(cacheFile, JSON.stringify(summary)).catch(() => {});
  return summary;
}

export async function pageDiff(store, archiveId, previousArchiveId, url) {
  const [current, previous] = await Promise.all([store.readManifest(archiveId), store.readManifest(previousArchiveId)]);
  if (!current || !previous) throw Object.assign(new Error('比べる前回のアーカイブが見つかりません。'), { code: 'PREVIOUS_NOT_FOUND', status: 404 });
  const key = stableDocumentKey(url);
  const page = indexPages(current).get(key) || [...indexPages(current).values()].find((item) => item.url === url);
  const old = indexPages(previous).get(page ? pageKey(page) : key);
  const [a, b] = await Promise.all([old ? pageLines(store, previousArchiveId, old) : [], page ? pageLines(store, archiveId, page) : []]);
  return { url, title: page?.title || old?.title || '', status: !old ? 'added' : !page ? 'removed' : 'compared', ops: diffLines(a, b) };
}
