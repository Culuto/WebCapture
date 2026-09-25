import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

test('Windows PowerShellとPowerShell 7でPID所有確認のUTC時刻が一致する', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows限定');
  const source = await fs.readFile(new URL('../AppDetail/Detail/WebCaptureController.ps1', import.meta.url), 'utf8');
  const helper = source.match(/function Resolve-ProcessStartTime\(\$value\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  for (const executable of ['powershell.exe', 'pwsh.exe']) {
    const command = `${helper}\n$fixture = '{"processStartTime":"2026-01-02T03:04:05.1234567Z"}' | ConvertFrom-Json\n(Resolve-ProcessStartTime $fixture.processStartTime).ToString('o')\n(Resolve-ProcessStartTime '2026-01-02T12:04:05.1234567+09:00').ToString('o')`;
    const { stdout } = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true });
    assert.deepEqual(stdout.trim().split(/\r?\n/), ['2026-01-02T03:04:05.1234567Z', '2026-01-02T03:04:05.1234567Z'], executable);
  }
});
