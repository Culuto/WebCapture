import path from 'node:path';
import { readJsonFile, createSerialWriter, randomId, serviceError } from './json-file.mjs';

export const BUILT_IN_PRESETS = Object.freeze([
  {
    id: 'builtin_heavy', name: '重いサイト用', builtIn: true,
    fields: { concurrency: '1', 'discovery-concurrency': '2', 'per-host-concurrency': '1', 'per-host-interval': '5000', 'interaction-limit': '100', 'interaction-mode': 'representative', 'media-strategy': 'background', 'media-speed': 'slow' }
  },
  {
    id: 'builtin_no_media', name: '動画なし', builtIn: true,
    fields: { 'save-media': false }
  },
  {
    id: 'builtin_quick', name: '手早く保存', builtIn: true,
    fields: { concurrency: '6', 'interaction-limit': '50', 'interaction-mode': 'representative', 'external-detail': 'light', 'capture-mobile': false }
  },
  {
    id: 'builtin_phone', name: 'PCとスマホの両方', builtIn: true,
    fields: { 'capture-mobile': true }
  }
]);

const FIELD_ID = /^[a-z][a-z0-9-]{0,39}$/;

export function sanitizePresetFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw serviceError('保存する設定の内容が正しくありません。', 'INVALID_PRESET');
  const output = {};
  for (const [key, value] of Object.entries(fields).slice(0, 60)) {
    if (!FIELD_ID.test(key)) continue;
    if (typeof value === 'boolean') output[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) output[key] = String(value);
    else if (typeof value === 'string' && value.length <= 500) output[key] = value;
  }
  if (!Object.keys(output).length) throw serviceError('保存する設定がありません。', 'EMPTY_PRESET');
  return output;
}

export class PresetStore {
  constructor({ dataRoot, now = () => new Date() }) {
    this.file = path.join(dataRoot, 'presets.json');
    this.write = createSerialWriter(this.file);
    this.now = now;
    this.items = [];
  }

  async init() {
    const saved = await readJsonFile(this.file, { items: [] });
    this.items = Array.isArray(saved.items) ? saved.items.filter((item) => item?.id && item.name && item.fields) : [];
    return this;
  }

  list() { return [...BUILT_IN_PRESETS.map((item) => ({ ...item, fields: { ...item.fields } })), ...this.items.map((item) => ({ ...item }))]; }

  async save({ name, fields, scope = null }) {
    const label = String(name || '').trim().slice(0, 60);
    if (!label) throw serviceError('プリセットの名前を入力してください。', 'NAME_REQUIRED');
    if (BUILT_IN_PRESETS.some((item) => item.name === label)) throw serviceError('組み込みのプリセットと同じ名前は使えません。', 'NAME_RESERVED');
    const clean = sanitizePresetFields(fields);
    const existing = this.items.find((item) => item.name === label);
    const item = existing || { id: randomId('preset'), name: label, createdAt: this.now().toISOString() };
    Object.assign(item, { fields: clean, scope: ['site', 'external'].includes(scope) ? scope : null, updatedAt: this.now().toISOString() });
    if (!existing) {
      if (this.items.length >= 50) throw serviceError('プリセットは50件までです。', 'TOO_MANY_PRESETS');
      this.items.push(item);
    }
    await this.write({ items: this.items });
    return { ...item };
  }

  async remove(id) {
    if (BUILT_IN_PRESETS.some((item) => item.id === id)) throw serviceError('組み込みのプリセットは削除できません。', 'BUILT_IN', 400);
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (before === this.items.length) throw serviceError('プリセットが見つかりません。', 'NOT_FOUND', 404);
    await this.write({ items: this.items });
    return true;
  }
}
