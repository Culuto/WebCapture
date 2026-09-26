import path from 'node:path';
import { readJsonFile, createSerialWriter, randomId } from './json-file.mjs';
import { logEvent } from './logger.mjs';

const KINDS = new Set(['schedule', 'watch', 'cleanup', 'batch', 'info']);

export class NotificationCenter {
  constructor({ dataRoot, desktop = null, desktopEnabled = () => true, limit = 200, now = () => new Date() }) {
    this.file = path.join(dataRoot, 'notifications.json');
    this.write = createSerialWriter(this.file);
    this.desktop = desktop;
    this.desktopEnabled = desktopEnabled;
    this.limit = limit;
    this.now = now;
    this.items = [];
  }

  async init() {
    const saved = await readJsonFile(this.file, { items: [] });
    this.items = Array.isArray(saved.items) ? saved.items.filter((item) => item && typeof item.id === 'string').slice(0, this.limit) : [];
    return this;
  }

  list({ limit = 50 } = {}) {
    return {
      items: this.items.slice(0, Math.max(1, Math.min(this.limit, Number(limit) || 50))),
      unread: this.items.filter((item) => !item.read).length
    };
  }

  async add({ kind = 'info', title, message = '', archiveId = null, url = null, action = null, desktop = true }) {
    const item = {
      id: randomId('note'), kind: KINDS.has(kind) ? kind : 'info',
      title: String(title || '').slice(0, 200), message: String(message || '').slice(0, 1000),
      ...(archiveId ? { archiveId: String(archiveId) } : {}), ...(url ? { url: String(url).slice(0, 2000) } : {}),
      ...(action ? { action: String(action).slice(0, 40) } : {}),
      createdAt: this.now().toISOString(), read: false
    };
    this.items.unshift(item);
    this.items.length = Math.min(this.items.length, this.limit);
    await this.write({ items: this.items });
    logEvent('info', 'notify', 'added', { kind: item.kind, title: item.title });
    if (desktop && this.desktop && this.desktopEnabled()) Promise.resolve(this.desktop(`WebCapture: ${item.title}`, item.message)).catch(() => {});
    return item;
  }

  async markRead(ids = null) {
    const wanted = Array.isArray(ids) ? new Set(ids.map(String)) : null;
    let changed = 0;
    for (const item of this.items) {
      if (item.read || (wanted && !wanted.has(item.id))) continue;
      item.read = true;
      changed += 1;
    }
    if (changed) await this.write({ items: this.items });
    return changed;
  }

  async clear() {
    this.items = [];
    await this.write({ items: this.items });
  }
}
