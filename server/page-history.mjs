import { stableDocumentKey } from './policy.mjs';

function keyOf(url) {
  try { return stableDocumentKey(url); } catch { return String(url || ''); }
}

export async function pageHistory(store, searchIndex, url, { limit = 60 } = {}) {
  const wanted = keyOf(url);
  const items = [];
  for (const archive of store.listArchives()) {
    if (['running', 'queued'].includes(archive.status)) continue;
    const entries = await searchIndex.entries(archive.id).catch(() => []);
    const match = entries.find((entry) => entry.url === url) || entries.find((entry) => keyOf(entry.url) === wanted);
    if (!match) continue;
    items.push({
      archiveId: archive.id, archiveTitle: archive.title || archive.startUrl, startUrl: archive.startUrl,
      savedAt: archive.savedAt, status: archive.status, url: match.url, title: match.title || ''
    });
    if (items.length >= limit) break;
  }
  items.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
  return { url, items };
}
