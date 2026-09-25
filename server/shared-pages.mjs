import fs from 'node:fs/promises';
import path from 'node:path';
import { logEvent } from './logger.mjs';

export class SharedPages {
  constructor({ dataRoot, store }) {
    this.root = path.join(dataRoot, 'shared');
    this.store = store;
    this.pages = new Map();
    this.references = new Map();
    this.linkCache = new Map();
    this.writeChain = Promise.resolve();
  }

  indexFile() { return path.join(this.root, 'page-index.jsonl'); }
  referenceFile() { return path.join(this.root, 'references.json'); }

  queue(task) {
    const run = this.writeChain.then(task);
    this.writeChain = run.catch((error) => logEvent('warn', 'shared', 'write.failed', { message: error.message }));
    return run;
  }

  async init() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(this.referenceFile(), 'utf8'));
      for (const [target, sources] of Object.entries(saved || {})) this.references.set(target, new Set(sources));
    } catch {}
    let text = null;
    try { text = await fs.readFile(this.indexFile(), 'utf8'); } catch {}
    if (text === null) {
      await this.rebuild();
      return this;
    }
    const removed = new Set();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.removeArchive) {
        removed.add(entry.removeArchive);
        for (const [url, value] of this.pages) if (value.archiveId === entry.removeArchive) this.pages.delete(url);
        continue;
      }
      if (entry.url && entry.archiveId && !removed.has(entry.archiveId)) this.pages.set(entry.url, { archiveId: entry.archiveId, pageUrl: entry.pageUrl || entry.url, at: entry.at });
    }
    for (const [url, value] of this.pages) if (!this.store.getArchive(value.archiveId)) this.pages.delete(url);
    await this.compact();
    return this;
  }

  async rebuild() {
    this.pages.clear();
    for (const archive of this.store.listArchives()) {
      const manifest = await this.store.readManifest(archive.id).catch(() => null);
      for (const page of manifest?.pages || []) {
        if (!page.html && !page.file) continue;
        for (const url of new Set([page.url, page.requestedUrl].filter(Boolean))) this.pages.set(url, { archiveId: archive.id, pageUrl: page.url, at: page.capturedAt });
      }
    }
    await this.compact();
    logEvent('info', 'shared', 'index.rebuilt', { pages: this.pages.size });
  }

  compact() {
    return this.queue(async () => {
      const lines = [...this.pages].map(([url, value]) => JSON.stringify({ url, archiveId: value.archiveId, pageUrl: value.pageUrl, at: value.at }));
      const temporary = `${this.indexFile()}.${process.pid}.tmp`;
      await fs.writeFile(temporary, lines.length ? `${lines.join('\n')}\n` : '');
      await fs.rename(temporary, this.indexFile());
    });
  }

  saveReferences() {
    return this.queue(async () => {
      const payload = Object.fromEntries([...this.references].filter(([, sources]) => sources.size).map(([target, sources]) => [target, [...sources]]));
      const temporary = `${this.referenceFile()}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(payload, null, 2));
      await fs.rename(temporary, this.referenceFile());
    });
  }

  lookup(url, excludeArchiveId) {
    const entry = this.pages.get(url);
    if (!entry || entry.archiveId === excludeArchiveId || !this.store.getArchive(entry.archiveId)) return null;
    return { archiveId: entry.archiveId, pageUrl: entry.pageUrl };
  }

  addPages(archiveId, pages) {
    const fresh = [];
    for (const page of pages) {
      for (const url of new Set([page.url, page.requestedUrl].filter(Boolean))) {
        const existing = this.pages.get(url);
        if (existing && existing.archiveId !== archiveId && this.store.getArchive(existing.archiveId)) continue;
        const value = { archiveId, pageUrl: page.url, at: page.capturedAt || new Date().toISOString() };
        this.pages.set(url, value);
        fresh.push(JSON.stringify({ url, ...value }));
      }
    }
    if (!fresh.length) return Promise.resolve();
    return this.queue(() => fs.appendFile(this.indexFile(), `${fresh.join('\n')}\n`));
  }

  addReference(fromArchiveId, toArchiveId) {
    if (!fromArchiveId || !toArchiveId || fromArchiveId === toArchiveId) return Promise.resolve();
    const sources = this.references.get(toArchiveId) || new Set();
    if (sources.has(fromArchiveId)) return Promise.resolve();
    sources.add(fromArchiveId);
    this.references.set(toArchiveId, sources);
    return this.saveReferences();
  }

  referencesTo(archiveId) {
    return [...(this.references.get(archiveId) || [])].filter((id) => id !== archiveId && this.store.getArchive(id));
  }

  async linksOf(archiveId, pageUrl) {
    const key = `${archiveId}|${pageUrl}`;
    if (this.linkCache.has(key)) return this.linkCache.get(key);
    const manifest = await this.store.readManifest(archiveId).catch(() => null);
    const page = manifest?.pages?.find((item) => item.url === pageUrl || item.requestedUrl === pageUrl);
    const result = { links: page?.links || [], title: page?.title || '' };
    this.linkCache.set(key, result);
    if (this.linkCache.size > 500) this.linkCache.delete(this.linkCache.keys().next().value);
    return result;
  }

  async removeArchive(archiveId) {
    for (const [url, value] of this.pages) if (value.archiveId === archiveId) this.pages.delete(url);
    this.references.delete(archiveId);
    for (const sources of this.references.values()) sources.delete(archiveId);
    for (const key of [...this.linkCache.keys()]) if (key.startsWith(`${archiveId}|`)) this.linkCache.delete(key);
    await this.queue(() => fs.appendFile(this.indexFile(), `${JSON.stringify({ removeArchive: archiveId })}\n`));
    await this.saveReferences();
  }
}
