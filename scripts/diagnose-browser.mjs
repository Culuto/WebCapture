import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findBrowsers, freePort } from '../server/browser-capture.mjs';

const WAIT_MS = 8000;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function run(command, args) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, { windowsHide: true, timeout: 15000, encoding: 'utf8' }, (error, stdout) => resolve(error ? '' : String(stdout || '')));
  });
}

async function browserVersion(executable) {
  try {
    const names = await fs.readdir(path.dirname(executable));
    const versions = names.filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (versions.length) return versions[0];
  } catch {}
  const output = await run(executable, ['--version']);
  return output.trim() || '不明';
}

async function devtoolsVersion(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (response.ok) return (await response.json()).Browser || 'OK';
  } catch {}
  return null;
}

function pipeVersion(handle) {
  return new Promise((resolve) => {
    const input = handle.stdio[3];
    const output = handle.stdio[4];
    if (!input || !output) return resolve(null);
    let buffer = '';
    const timer = setTimeout(() => resolve(null), 3000);
    output.on('data', (chunk) => {
      buffer += String(chunk);
      const end = buffer.indexOf('\0');
      if (end < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(buffer.slice(0, end)).result?.product || 'OK'); } catch { resolve('OK'); }
    });
    output.on('error', () => {});
    input.on('error', () => {});
    input.write(`${JSON.stringify({ id: 1, method: 'Browser.getVersion' })}\0`);
  });
}

async function stop(handle) {
  if (handle.exitCode !== null || handle.signalCode !== null) return;
  const exited = new Promise((resolve) => handle.once('exit', resolve));
  if (process.platform === 'win32') await run('taskkill', ['/PID', String(handle.pid), '/T', '/F']);
  else handle.kill('SIGKILL');
  await Promise.race([exited, delay(3000)]);
}

async function logTail(profile) {
  try {
    const text = await fs.readFile(path.join(profile, 'chrome_debug.log'), 'utf8');
    return text.split(/\r?\n/)
      .filter((line) => /ERROR|FATAL|exit|policy|debugging|headless/i.test(line) && !/dbus|ssl_client_socket|idle_linux|gcm|google_apis|update_client|component_updater/i.test(line))
      .slice(-6);
  } catch { return []; }
}

async function tryLaunch(executable, variant) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-diagnose-'));
  const port = await freePort();
  const args = [
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
    ...variant.args(port), '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--enable-logging', '--v=0', 'about:blank'
  ];
  const started = Date.now();
  const handle = childProcess.spawn(executable, args, { stdio: variant.pipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'], windowsHide: true });
  let spawnError = null;
  handle.on('error', (error) => { spawnError = error; });
  let connected = null;
  while (Date.now() - started < WAIT_MS && handle.exitCode === null && handle.signalCode === null && !connected && !spawnError) {
    await delay(250);
    connected = variant.pipe ? await pipeVersion(handle) : variant.port ? await devtoolsVersion(port) : null;
  }
  if (!variant.pipe && !variant.port) await delay(Math.max(0, 4000 - (Date.now() - started)));
  const alive = handle.exitCode === null && handle.signalCode === null && !spawnError;
  const result = {
    variant: variant.label, alive, connected, exitCode: handle.exitCode, elapsedMs: Date.now() - started,
    error: spawnError?.message || null, log: []
  };
  await stop(handle);
  await delay(500);
  result.log = await logTail(profile);
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  return result;
}

const VARIANTS = [
  { label: 'WebCaptureと同じ起動（画面なし＋接続口）', port: true, args: (port) => ['--headless=new', `--remote-debugging-port=${port}`] },
  { label: '画面なし・接続口なし', args: () => ['--headless=new'] },
  { label: '画面なし＋パイプ接続', pipe: true, args: () => ['--headless=new', '--remote-debugging-pipe'] },
  { label: '画面外に表示＋接続口', port: true, args: (port) => ['--window-position=-32000,-32000', '--window-size=800,600', `--remote-debugging-port=${port}`] }
];

async function policies() {
  if (process.platform !== 'win32') return [];
  const keys = ['HKLM\\SOFTWARE\\Policies\\Google\\Chrome', 'HKCU\\SOFTWARE\\Policies\\Google\\Chrome', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge', 'HKCU\\SOFTWARE\\Policies\\Microsoft\\Edge'];
  const found = [];
  for (const key of keys) {
    const output = await run('reg', ['query', key]);
    for (const line of output.split(/\r?\n/)) {
      if (/RemoteDebuggingAllowed|HeadlessMode|DeveloperToolsAvailability/i.test(line)) found.push(`${key}: ${line.trim()}`);
    }
  }
  return found;
}

async function leftoverBrowsers() {
  if (process.platform !== 'win32') return null;
  const output = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | Where-Object { $_.CommandLine -like '*webcapture-browser-*' }).Count"]);
  const count = Number.parseInt(output.trim(), 10);
  return Number.isFinite(count) ? count : null;
}

const browsers = await findBrowsers();
console.log('WebCapture ブラウザ診断');
console.log(`OS: ${os.type()} ${os.release()} / Node.js ${process.version}`);
if (!browsers.length) {
  console.log('ChromeまたはEdgeが見つかりません。');
  process.exit(1);
}
const leftovers = await leftoverBrowsers();
if (leftovers !== null) console.log(`WebCaptureが起動したまま残っているブラウザ: ${leftovers}個`);
const policyLines = await policies();
console.log(policyLines.length ? `ブラウザのポリシー設定:\n  ${policyLines.join('\n  ')}` : 'ブラウザのポリシー設定: 関係する設定はありません。');
for (const executable of browsers) {
  console.log(`\n■ ${path.basename(executable)} ${await browserVersion(executable)}`);
  for (const variant of VARIANTS) {
    const result = await tryLaunch(executable, variant);
    const state = result.error ? `起動できません（${result.error}）`
      : result.connected ? `正常（接続できました: ${result.connected}）`
        : result.alive ? (variant.port || variant.pipe ? '動いていますが接続できません' : '正常（動いています）')
          : `終了しました（終了コード ${result.exitCode}、${result.elapsedMs}ミリ秒）`;
    console.log(`  - ${result.variant}: ${state}`);
    for (const line of result.log) console.log(`      ${line.slice(0, 300)}`);
  }
}
