import fs from 'node:fs/promises';
import path from 'node:path';
import { cssAssetReferences } from './asset-references.mjs';
import { decodeStoredText } from './charset.mjs';

export const STORAGE_CATEGORIES = Object.freeze([
  { key: 'media', label: '動画・音声' },
  { key: 'image', label: '画像' },
  { key: 'background', label: '背景画像（CSSで読み込む画像）' },
  { key: 'font', label: 'フォント' },
  { key: 'system', label: 'スクリプト・スタイル（システム）' },
  { key: 'page', label: 'ページ本体（HTML）' },
  { key: 'data', label: '通信データ（APIの応答など）' },
  { key: 'screenshot', label: 'スクリーンショット' },
  { key: 'warc', label: '通信記録（WARC）' },
  { key: 'other', label: 'その他' }
]);

const SUMMARY_FILE = 'storage-summary.json';
const SUMMARY_VERSION = 1;

function mimeOf(resource = {}) {
  return String(resource.mimeType || resource.headers?.['content-type'] || resource.headers?.['Content-Type'] || '').toLowerCase();
}

function pathOf(url) {
  try { return new URL(url).pathname.toLowerCase(); } catch { return ''; }
}

export function resourceCategory(resource = {}, backgroundUrls = new Set()) {
  const mime = mimeOf(resource);
  const file = pathOf(resource.url);
  if (/^(?:video|audio)\//.test(mime) || /mpegurl|dash\+xml|mp2t/.test(mime) || /\.(?:mp4|m4v|m4s|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac|ts|m3u8|mpd)$/.test(file)) return 'media';
  if (/^image\//.test(mime) || /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(file)) return backgroundUrls.has(resource.url) ? 'background' : 'image';
  if (/^font\/|woff|opentype|truetype|x-font/.test(mime) || /\.(?:woff2?|ttf|otf|eot)$/.test(file)) return 'font';
  if (/javascript|ecmascript|text\/css|wasm/.test(mime) || /\.(?:m?js|css|wasm)$/.test(file)) return 'system';
  if (/text\/html|xhtml/.test(mime)) return 'page';
  if (/json|xml|text\/plain|protobuf|graphql|x-www-form/.test(mime)) return 'data';
  return 'other';
}

async function fileSize(file) {
  try { return (await fs.stat(file)).size; } catch { return 0; }
}

async function directorySize(directory) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    total += entry.isDirectory() ? await directorySize(target) : await fileSize(target);
  }
  return total;
}

async function backgroundImageUrls(manifest, archiveRoot) {
  const urls = new Set();
  for (const resource of Object.values(manifest.resources || {})) {
    if (!/text\/css/i.test(mimeOf(resource)) || !resource.file) continue;
    try {
      const css = decodeStoredText(await fs.readFile(path.join(archiveRoot, resource.file)), resource);
      for (const value of cssAssetReferences(css, resource.url)) urls.add(value);
    } catch {}
  }
  for (const page of manifest.pages || []) {
    if (!page.html) continue;
    try {
      const html = await fs.readFile(path.join(archiveRoot, page.html), 'utf8');
      for (const block of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) for (const value of cssAssetReferences(block[1], page.url)) urls.add(value);
      for (const attribute of html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
        const decoded = String(attribute[1] ?? attribute[2] ?? '').replace(/&quot;/gi, '"').replace(/&#39;/g, "'").replace(/&amp;/gi, '&');
        for (const value of cssAssetReferences(decoded, page.url)) urls.add(value);
      }
    } catch {}
  }
  for (const [alias, target] of Object.entries(manifest.resourceAliases || {})) if (urls.has(alias)) urls.add(target);
  return urls;
}

export async function computeStorageSummary(manifest = {}, archiveRoot) {
  const totals = Object.fromEntries(STORAGE_CATEGORIES.map(({ key }) => [key, { bytes: 0, count: 0 }]));
  const counted = new Set();
  const add = (key, file, size) => {
    const bytes = Number(size) || 0;
    if (file) {
      if (counted.has(file)) return;
      counted.add(file);
    }
    totals[key].bytes += bytes;
    totals[key].count += 1;
  };
  const backgrounds = await backgroundImageUrls(manifest, archiveRoot);
  for (const page of manifest.pages || []) if (page.html) add('page', page.html, page.htmlSize ?? await fileSize(path.join(archiveRoot, page.html)));
  const resources = [
    ...Object.values(manifest.resources || {}),
    ...Object.values(manifest.resourceVariants || {}).flat().map((variant) => ({ ...variant, url: variant.url || '' })),
    ...Object.values(manifest.postResponses || {}).map((item) => ({ ...item, mimeType: item.mimeType || 'application/json' }))
  ];
  for (const resource of resources) {
    if (!resource?.file) continue;
    add(resourceCategory(resource, backgrounds), resource.file, resource.size);
  }
  totals.screenshot.bytes = await directorySize(path.join(archiveRoot, 'screenshots'));
  totals.screenshot.count = (manifest.pages || []).filter((page) => page.screenshot).length;
  totals.warc.bytes = await fileSize(path.join(archiveRoot, 'collection.warc.gz'));
  totals.warc.count = totals.warc.bytes ? 1 : 0;
  const categories = STORAGE_CATEGORIES.map(({ key, label }) => ({ key, label, ...totals[key] }));
  return { version: SUMMARY_VERSION, categories, totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0), computedAt: new Date().toISOString() };
}

export async function storageSummary(store, archiveId) {
  const archiveRoot = store.archiveRoot(archiveId);
  const manifestStat = await fs.stat(store.manifestFile(archiveId));
  const signature = `${manifestStat.mtimeMs}:${manifestStat.size}`;
  const cacheFile = path.join(archiveRoot, SUMMARY_FILE);
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (cached.version === SUMMARY_VERSION && cached.signature === signature) return cached;
  } catch {}
  const manifest = await store.readManifest(archiveId);
  const summary = { ...await computeStorageSummary(manifest || {}, archiveRoot), signature };
  await fs.writeFile(cacheFile, JSON.stringify(summary)).catch(() => {});
  return summary;
}
