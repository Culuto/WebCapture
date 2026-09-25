import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logEvent } from './logger.mjs';

const COOKIE_FILES = [['Local State'], ['Default', 'Network', 'Cookies'], ['Default', 'Network', 'Cookies-journal'], ['Default', 'Cookies'], ['Default', 'Cookies-journal']];
const NAME_LIMIT = 60;
export const LOGIN_START_URL = 'https://www.google.com/';

function safeName(value) {
  return String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, NAME_LIMIT);
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

export function parseCookieText(text, siteUrl = '') {
  const input = String(text || '').trim();
  if (!input) throw new Error('Cookieが入力されていません。');
  const cookies = [];
  if (/^[[{]/.test(input)) {
    let parsed;
    try { parsed = JSON.parse(input); } catch { throw new Error('CookieのJSONを読み取れません。'); }
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.cookies) ? parsed.cookies : [parsed];
    for (const item of list) {
      if (!item?.name || item.value === undefined || !item.domain) continue;
      const expires = Number(item.expirationDate ?? item.expires ?? item.expiry);
      cookies.push({
        name: String(item.name), value: String(item.value), domain: String(item.domain), path: String(item.path || '/'),
        secure: Boolean(item.secure), httpOnly: Boolean(item.httpOnly),
        ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
        ...(/^(?:strict|lax|none)$/i.test(item.sameSite || '') ? { sameSite: item.sameSite[0].toUpperCase() + item.sameSite.slice(1).toLowerCase() } : {})
      });
    }
  } else if (/\t/.test(input)) {
    for (const line of input.split(/\r?\n/)) {
      if (!line.trim() || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
      const httpOnly = line.startsWith('#HttpOnly_');
      const parts = line.replace(/^#HttpOnly_/, '').split('\t');
      if (parts.length < 7) continue;
      const [domain, , cookiePath, secure, expiry, name, value] = parts;
      const expires = Number(expiry);
      cookies.push({ name, value, domain, path: cookiePath || '/', secure: secure === 'TRUE', httpOnly, ...(expires > 0 ? { expires } : {}) });
    }
  } else {
    let host;
    try { host = new URL(siteUrl).hostname; } catch { throw new Error('「名前=値」形式のCookieには、対象サイトのURLが必要です。'); }
    for (const pair of input.replace(/^cookie:\s*/i, '').split(';')) {
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      cookies.push({ name: pair.slice(0, index).trim(), value: pair.slice(index + 1).trim(), domain: host, path: '/', secure: siteUrl.startsWith('https:') });
    }
  }
  if (!cookies.length) throw new Error('読み取れるCookieがありませんでした。');
  const defaultExpiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  return cookies.map((cookie) => (cookie.expires ? cookie : { ...cookie, expires: defaultExpiry }));
}

export function defaultBrowserUserData(browser) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return browser === 'edge' ? path.join(local, 'Microsoft', 'Edge', 'User Data') : path.join(local, 'Google', 'Chrome', 'User Data');
}

export class LoginProfiles {
  constructor({ dataRoot, findBrowser, createSession, CdpClient, spawn = childProcess.spawn }) {
    this.spawn = spawn;
    this.root = path.join(dataRoot, 'logins');
    this.findBrowser = findBrowser;
    this.createSession = createSession;
    this.CdpClient = CdpClient;
    this.windows = new Map();
    this.writeChain = Promise.resolve();
  }

  listFile() { return path.join(this.root, 'logins.json'); }
  profileDir(id) { return path.join(this.root, id, 'profile'); }

  async init() {
    const list = await this.list();
    if (list.some((item) => item.status === 'waiting')) await this.saveList(list.map((item) => item.status === 'waiting' ? { ...item, status: 'ready' } : item));
    return this;
  }

  bringToFront(pid) {
    if (process.platform !== 'win32' || !pid) return;
    const script = `$shell = New-Object -ComObject WScript.Shell; for ($i = 0; $i -lt 20; $i++) { if ($shell.AppActivate(${Number(pid)})) { break }; Start-Sleep -Milliseconds 300 }`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    childProcess.execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15000 }, () => {});
  }

  async list() {
    try { return JSON.parse(await fs.readFile(this.listFile(), 'utf8')); } catch { return []; }
  }

  async get(id) {
    return (await this.list()).find((item) => item.id === id) || null;
  }

  saveList(list) {
    const write = this.writeChain.then(async () => {
      await fs.mkdir(this.root, { recursive: true });
      const temporary = `${this.listFile()}.${process.pid}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(list, null, 2));
      await fs.rename(temporary, this.listFile());
    });
    this.writeChain = write.catch(() => {});
    return write;
  }

  async upsert(entry) {
    const list = await this.list();
    const index = list.findIndex((item) => item.id === entry.id);
    if (index >= 0) list[index] = { ...list[index], ...entry }; else list.push(entry);
    await this.saveList(list);
    return list.find((item) => item.id === entry.id);
  }

  async create({ name, method }) {
    const id = `login_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    await fs.mkdir(this.profileDir(id), { recursive: true });
    const now = new Date().toISOString();
    return this.upsert({ id, name: safeName(name) || 'ログイン', method, status: 'ready', createdAt: now, updatedAt: now });
  }

  async importPastedCookies({ name, text, siteUrl }) {
    const cookies = parseCookieText(text, siteUrl);
    const entry = await this.create({ name, method: 'paste' });
    const executable = await this.findBrowser();
    const session = await this.createSession({ executable, userDataDir: this.profileDir(entry.id), keepProfile: true });
    try {
      const version = await fetch(`http://127.0.0.1:${session.port}/json/version`).then((response) => response.json());
      const client = await new this.CdpClient(version.webSocketDebuggerUrl).connect();
      try {
        await client.send('Storage.setCookies', { cookies });
        await client.send('Browser.close', {}, 10000).catch(() => {});
      } finally { client.close(); }
      await new Promise((resolve) => setTimeout(resolve, 800));
    } finally { await session.close(); }
    logEvent('info', 'login', 'profile.imported', { id: entry.id, method: 'paste', cookieCount: cookies.length });
    return this.upsert({ ...entry, cookieCount: cookies.length, updatedAt: new Date().toISOString() });
  }

  async importFromBrowser({ name, browser = 'chrome' }) {
    const source = defaultBrowserUserData(browser);
    if (!await exists(path.join(source, 'Local State'))) throw new Error(browser === 'edge' ? 'Edgeの保存データが見つかりません。' : 'Chromeの保存データが見つかりません。');
    const entry = await this.create({ name, method: browser === 'edge' ? 'edge' : 'chrome' });
    const target = this.profileDir(entry.id);
    let copied = 0;
    try {
      for (const parts of COOKIE_FILES) {
        const from = path.join(source, ...parts);
        if (!await exists(from)) continue;
        await fs.mkdir(path.dirname(path.join(target, ...parts)), { recursive: true });
        await fs.copyFile(from, path.join(target, ...parts));
        copied += 1;
      }
    } catch (error) {
      await this.remove(entry.id).catch(() => {});
      if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw new Error(`${browser === 'edge' ? 'Edge' : 'Chrome'}が開いているためCookieを読み込めません。すべてのウィンドウを閉じてからもう一度試してください。`);
      throw error;
    }
    if (copied < 2) {
      await this.remove(entry.id).catch(() => {});
      throw new Error('Cookieのファイルが見つかりません。');
    }
    logEvent('info', 'login', 'profile.imported', { id: entry.id, method: entry.method });
    return this.upsert({ ...entry, updatedAt: new Date().toISOString() });
  }

  async openLoginWindow({ id, name, url }) {
    let entry = id ? await this.get(id) : null;
    if (id && !entry) throw new Error('ログイン設定が見つかりません。');
    if (!entry) entry = await this.create({ name, method: 'manual' });
    if (this.windows.has(entry.id)) throw new Error('このログイン設定のウィンドウはすでに開いています。');
    let target;
    try { target = new URL(url || LOGIN_START_URL); } catch { throw new Error('開くページのURLが正しくありません。'); }
    if (!/^https?:$/.test(target.protocol)) throw new Error('http・httpsのURLだけ開けます。');
    const executable = await this.findBrowser();
    if (!executable) throw new Error('ChromeまたはEdgeが見つかりません。');
    const child = this.spawn(executable, [`--user-data-dir=${this.profileDir(entry.id)}`, '--no-first-run', '--no-default-browser-check', '--new-window', target.href], { stdio: 'ignore', windowsHide: false, detached: false });
    this.windows.set(entry.id, child);
    if (this.spawn === childProcess.spawn) this.bringToFront(child.pid);
    await this.upsert({ ...entry, status: 'waiting', updatedAt: new Date().toISOString() });
    child.once('exit', () => {
      this.windows.delete(entry.id);
      this.upsert({ ...entry, status: 'ready', updatedAt: new Date().toISOString() }).catch(() => {});
      logEvent('info', 'login', 'window.closed', { id: entry.id });
    });
    logEvent('info', 'login', 'window.opened', { id: entry.id });
    return this.get(entry.id);
  }

  async copyInto(id, userDataDir) {
    const source = this.profileDir(id);
    let copied = 0;
    for (const parts of COOKIE_FILES) {
      const from = path.join(source, ...parts);
      if (!await exists(from)) continue;
      await fs.mkdir(path.dirname(path.join(userDataDir, ...parts)), { recursive: true });
      await fs.copyFile(from, path.join(userDataDir, ...parts));
      copied += 1;
    }
    return copied;
  }

  async remove(id) {
    if (this.windows.has(id)) throw new Error('ログイン用のウィンドウを閉じてから削除してください。');
    await fs.rm(path.join(this.root, id), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await this.saveList((await this.list()).filter((item) => item.id !== id));
    logEvent('info', 'login', 'profile.removed', { id });
  }
}
