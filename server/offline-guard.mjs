import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { logEvent } from './logger.mjs';

// Reserve the app's existing port before a maintenance writer opens its state.
// A running app is rejected; a new app cannot start until maintenance finishes.
export async function reserveOfflinePort(host, port) {
  const guard = net.createServer(socket => socket.destroy());
  try {
    await new Promise((resolve, reject) => { guard.once('error', reject); guard.listen(port, host, resolve); });
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      const busy = new Error('アプリが使用中のため補完は実行できません。保存処理が終了し、アプリを停止してから実行してください。');
      busy.code = 'APP_IN_USE';
      throw busy;
    }
    throw error;
  }
  return { close: () => new Promise(resolve => guard.close(resolve)) };
}

export async function reserveDataWriter(dataRoot) {
  await fs.mkdir(dataRoot, { recursive: true });
  let canonical = await fs.realpath(path.resolve(dataRoot));
  if (process.platform === 'win32') canonical = canonical.replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase();
  const identity = crypto.createHash('sha256').update(canonical).digest('hex');
  const guard = net.createServer(socket => socket.destroy());
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\webcapture-writer-${identity}`
    : process.platform === 'linux' ? `\0webcapture-writer-${identity}`
      : { host: '127.0.0.1', port: 20000 + Number.parseInt(identity.slice(0, 8), 16) % 20000, exclusive: true };
  try {
    await new Promise((resolve, reject) => { guard.once('error', reject); guard.listen(endpoint, resolve); });
  } catch (error) {
    if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
      const busy = new Error('同じ保存先を使用するアプリまたは補完処理が稼働中です。先に終了してから実行してください。');
      busy.code = 'DATA_ROOT_IN_USE';
      throw busy;
    }
    throw error;
  }
  logEvent('info', 'store', 'data.writer.reserved', { identity: identity.slice(0, 12) });
  return { close: () => new Promise(resolve => { if (!guard.listening) return resolve(); guard.close(resolve); }) };
}
