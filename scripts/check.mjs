import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
async function collect(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['data','runtime','node_modules'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(full));
    else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(full);
  }
  return files;
}
for (const file of await collect(root)) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path.relative(root, file)}: ${result.stderr || result.stdout}`);
}
const appDetail = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-appdetail.mjs')], { encoding: 'utf8' });
if (appDetail.status !== 0) throw new Error(appDetail.stderr || appDetail.stdout);
console.log('Static check passed');
