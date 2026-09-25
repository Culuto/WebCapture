import fs from 'node:fs/promises';
import path from 'node:path';

const INDEX_FILE = 'search-index.jsonl';
const MAX_TEXT = 200000;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function htmlToSearchText(html = '') {
  return String(html)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === '#') {
        const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : ' ';
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

export class SearchIndex {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
  }

  indexFile(archiveId) {
    return path.join(this.store.archiveRoot(archiveId), INDEX_FILE);
  }

  async append(archiveId, pages) {
    if (!pages.length) return;
    const lines = pages.map((page) => JSON.stringify({ url: page.url, title: page.title || '', text: htmlToSearchText(page.html) })).join('\n') + '\n';
    await fs.appendFile(this.indexFile(archiveId), lines, 'utf8');
    this.cache.delete(archiveId);
  }

  async build(archiveId) {
    const manifest = await this.store.readManifest(archiveId).catch(() => null);
    if (!manifest?.pages?.length) return [];
    const root = this.store.archiveRoot(archiveId);
    const entries = [];
    for (const page of manifest.pages) {
      if (!page.html) continue;
      const html = await fs.readFile(path.join(root, page.html), 'utf8').catch(() => '');
      entries.push({ url: page.url, title: page.title || '', text: htmlToSearchText(html) });
    }
    await fs.writeFile(this.indexFile(archiveId), entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
    return entries;
  }

  async entries(archiveId) {
    const file = this.indexFile(archiveId);
    let stat = null;
    try { stat = await fs.stat(file); } catch {}
    const cached = this.cache.get(archiveId);
    if (stat && cached?.mtimeMs === stat.mtimeMs) return cached.entries;
    let entries;
    if (stat) {
      const text = await fs.readFile(file, 'utf8');
      const latest = new Map();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const entry = JSON.parse(line); latest.set(entry.url, entry); } catch {}
      }
      entries = [...latest.values()];
    } else {
      entries = await this.build(archiveId);
      try { stat = await fs.stat(file); } catch {}
    }
    this.cache.set(archiveId, { mtimeMs: stat?.mtimeMs || 0, entries });
    return entries;
  }

  async search(query, { limit = 50 } = {}) {
    const terms = String(query || '').toLowerCase().split(/\s+/).map((term) => term.trim()).filter(Boolean).slice(0, 8);
    if (!terms.length) return { results: [], total: 0 };
    const results = [];
    let total = 0;
    for (const archive of this.store.listArchives()) {
      const entries = await this.entries(archive.id).catch(() => []);
      for (const entry of entries) {
        const haystack = `${entry.title} ${entry.text}`.toLowerCase();
        if (!terms.every((term) => haystack.includes(term))) continue;
        total += 1;
        if (results.length >= limit) continue;
        const position = entry.text.toLowerCase().indexOf(terms[0]);
        const start = Math.max(0, position - 60);
        const snippet = position >= 0 ? `${start > 0 ? '…' : ''}${entry.text.slice(start, position + terms[0].length + 80)}…` : entry.text.slice(0, 140);
        results.push({ archiveId: archive.id, archiveTitle: archive.title || archive.startUrl, url: entry.url, title: entry.title, snippet });
      }
    }
    return { results, total };
  }

  forget(archiveId) {
    this.cache.delete(archiveId);
  }
}
