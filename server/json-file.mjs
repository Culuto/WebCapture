import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export async function writeJsonFileAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function createSerialWriter(file) {
  let tail = Promise.resolve();
  return (value) => {
    const snapshot = structuredClone(value);
    const run = tail.then(() => writeJsonFileAtomic(file, snapshot));
    tail = run.catch(() => {});
    return run;
  };
}

export function serviceError(message, code, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}
