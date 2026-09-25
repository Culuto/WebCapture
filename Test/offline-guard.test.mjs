import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { reserveDataWriter } from '../server/offline-guard.mjs';

test('同じ保存先の表記違いでも二重書込みを拒否し、別保存先は同時に使用できる', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-writer-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await reserveDataWriter(path.join(root, 'first'));
  t.after(() => first.close());
  const equivalent = process.platform === 'win32' ? path.join(root, 'first').toUpperCase() : path.join(root, 'first', '.');
  await assert.rejects(reserveDataWriter(equivalent), { code: 'DATA_ROOT_IN_USE' });
  const separate = await reserveDataWriter(path.join(root, 'separate'));
  await separate.close();
  await first.close();
  const reopened = await reserveDataWriter(path.join(root, 'first'));
  await reopened.close();
});

test('所有プロセスを強制終了した後も、残留ロックなしで同じ保存先を再使用できる', { timeout: 10000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-writer-crash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../server/offline-guard.mjs')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { reserveDataWriter } from ${JSON.stringify(moduleUrl)}; await reserveDataWriter(${JSON.stringify(root)}); process.stdout.write('ready');`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); } });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', data => data.toString() === 'ready' ? resolve() : reject(new Error('所有確認の準備応答が違います。')));
    child.once('error', reject);
    child.once('exit', () => reject(new Error('所有確認プロセスが準備前に終了しました。')));
  });
  await assert.rejects(reserveDataWriter(root), { code: 'DATA_ROOT_IN_USE' });
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exit;
  const recovered = await reserveDataWriter(root);
  await recovered.close();
  assert.equal((await fs.readdir(root)).length, 0);
});
