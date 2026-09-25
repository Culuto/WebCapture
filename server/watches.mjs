import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonFile, createSerialWriter, randomId, serviceError } from './json-file.mjs';
import { logEvent, safeUrl } from './logger.mjs';
import { htmlToSearchText } from './search-index.mjs';
import { navigateAndSettle, withInternetPage, evaluateValue } from './browser-page.mjs';

export const WATCH_INTERVALS = Object.freeze([15, 60, 180, 360, 720, 1440, 10080]);
const MAX_EXCERPT = 600;
const MAX_HISTORY = 20;

export function normalizeWatchText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 100000);
}

function excerpt(value) {
  const text = normalizeWatchText(value);
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text;
}

function digest(value) {
  return crypto.createHash('sha256').update(normalizeWatchText(value)).digest('hex');
}

export function validateSelector(value) {
  const selector = String(value || '').trim();
  if (selector.length > 300 || /[\u0000-\u001f]/.test(selector)) throw serviceError('見張る部分の指定が長すぎるか、使えない文字を含んでいます。', 'INVALID_SELECTOR');
  return selector;
}

const READ_EXPRESSION = (selector) => `(() => {
  const selector = ${JSON.stringify(selector)};
  if (!selector) return { found: true, text: document.body ? document.body.innerText : '' };
  let nodes;
  try { nodes = [...document.querySelectorAll(selector)]; } catch { return { invalid: true }; }
  if (!nodes.length) return { found: false };
  return { found: true, text: nodes.slice(0, 20).map((node) => node.innerText || node.textContent || '').join('\\n') };
})()`;

export async function browserWatchReader({ url, selector }, options = {}) {
  return withInternetPage(async (client) => {
    await navigateAndSettle(client, url, { timeoutMs: 45000, settleMs: 2000 });
    const result = evaluateValue(await client.send('Runtime.evaluate', { expression: READ_EXPRESSION(selector), returnByValue: true }, 20000));
    if (result?.invalid) throw serviceError('見張る部分の指定（CSSセレクタ）の書き方が正しくありません。', 'INVALID_SELECTOR');
    if (!result?.found) throw serviceError('指定した部分がページ内に見つかりませんでした。', 'SELECTOR_NOT_FOUND');
    return { text: result.text };
  }, options);
}

export function httpWatchReader(fetcher) {
  return async ({ url, selector }, options = {}) => {
    if (selector) throw serviceError('部分を指定して見張るにはChromeまたはEdgeが必要です。', 'BROWSER_UNAVAILABLE');
    const { response } = await fetcher(url, { ...options, requestTimeoutMs: 30000 });
    if (!response.ok) throw serviceError(`ページを開けませんでした（HTTP ${response.status}）。`, 'HTTP_ERROR');
    return { text: htmlToSearchText(await response.text()) };
  };
}

export class WatchService {
  constructor({ dataRoot, reader, assertUrl, notifications = null, now = () => new Date(), intervalMs = 60000 }) {
    this.file = path.join(dataRoot, 'watches.json');
    this.write = createSerialWriter(this.file);
    this.reader = reader;
    this.assertUrl = assertUrl;
    this.notifications = notifications;
    this.now = now;
    this.intervalMs = intervalMs;
    this.items = [];
    this.timer = null;
    this.running = new Set();
    this.ticking = null;
  }

  async init() {
    const saved = await readJsonFile(this.file, { items: [] });
    this.items = Array.isArray(saved.items) ? saved.items.filter((item) => item?.id && item.url) : [];
    return this;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((error) => logEvent('warn', 'watch', 'tick.failed', { message: error.message })); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
  save() { return this.write({ items: this.items }); }
  publicItem(item) { return { ...item, checking: this.running.has(item.id) }; }
  list() { return this.items.map((item) => this.publicItem(item)); }

  async add({ url, selector = '', label = '', intervalMinutes = 1440 }) {
    const checked = await this.assertUrl(url);
    const minutes = WATCH_INTERVALS.includes(Number(intervalMinutes)) ? Number(intervalMinutes) : 1440;
    if (this.items.length >= 100) throw serviceError('見張りは100件までです。不要なものを削除してください。', 'TOO_MANY_WATCHES');
    const item = {
      id: randomId('watch'), url: checked.url, selector: validateSelector(selector), label: String(label || '').trim().slice(0, 100),
      intervalMinutes: minutes, enabled: true, createdAt: this.now().toISOString(),
      lastCheckedAt: null, lastChangedAt: null, lastExcerpt: '', lastHash: null, lastError: null, history: [],
      nextCheckAt: this.now().toISOString()
    };
    this.items.push(item);
    await this.save();
    logEvent('info', 'watch', 'added', { watchId: item.id, url: safeUrl(item.url), hasSelector: Boolean(item.selector), intervalMinutes: minutes });
    return this.publicItem(item);
  }

  async update(id, patch = {}) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) throw serviceError('見張りが見つかりません。', 'NOT_FOUND', 404);
    if (patch.enabled !== undefined) item.enabled = patch.enabled === true;
    if (patch.intervalMinutes !== undefined && WATCH_INTERVALS.includes(Number(patch.intervalMinutes))) item.intervalMinutes = Number(patch.intervalMinutes);
    if (patch.label !== undefined) item.label = String(patch.label || '').trim().slice(0, 100);
    if (item.enabled && !item.nextCheckAt) item.nextCheckAt = this.now().toISOString();
    await this.save();
    return this.publicItem(item);
  }

  async remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (before === this.items.length) throw serviceError('見張りが見つかりません。', 'NOT_FOUND', 404);
    await this.save();
    return true;
  }

  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const now = this.now();
      for (const item of [...this.items]) {
        if (!item.enabled || this.running.has(item.id) || (item.nextCheckAt && new Date(item.nextCheckAt) > now)) continue;
        await this.check(item.id).catch(() => {});
      }
    })().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  async check(id) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) throw serviceError('見張りが見つかりません。', 'NOT_FOUND', 404);
    if (this.running.has(id)) return this.publicItem(item);
    this.running.add(id);
    const now = this.now();
    try {
      await this.assertUrl(item.url);
      const { text } = await this.reader({ url: item.url, selector: item.selector });
      const hash = digest(text);
      const changed = item.lastHash !== null && hash !== item.lastHash;
      const previous = item.lastExcerpt;
      item.lastCheckedAt = now.toISOString();
      item.lastError = null;
      if (item.lastHash === null || changed) {
        item.lastExcerpt = excerpt(text);
        item.history = [{ at: now.toISOString(), excerpt: item.lastExcerpt }, ...(item.history || [])].slice(0, MAX_HISTORY);
      }
      if (changed) {
        item.lastChangedAt = now.toISOString();
        const name = item.label || new URL(item.url).hostname;
        await this.notifications?.add({ kind: 'watch', title: `変化がありました（${name}）`, message: `前：${previous.slice(0, 120)}\n今：${item.lastExcerpt.slice(0, 120)}`, url: item.url });
        logEvent('info', 'watch', 'changed', { watchId: id, url: safeUrl(item.url) });
      }
      item.lastHash = hash;
    } catch (error) {
      item.lastCheckedAt = now.toISOString();
      item.lastError = String(error.message || error).slice(0, 300);
      logEvent('warn', 'watch', 'check.failed', { watchId: id, url: safeUrl(item.url), code: error.code || 'CHECK_FAILED', message: item.lastError });
    } finally {
      item.nextCheckAt = new Date(now.getTime() + item.intervalMinutes * 60000).toISOString();
      this.running.delete(id);
      await this.save();
    }
    return this.publicItem(item);
  }
}
