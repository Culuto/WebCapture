import { VISUAL_MATCH_THRESHOLD } from './replay-auditor.mjs';

export function visualPages(audit) {
  return (audit?.pages || [])
    .filter((page) => page.visual?.saved && page.visual?.replay)
    .map((page) => ({
      url: page.url, title: page.title || page.savedTitle || '',
      similarity: Number.isFinite(page.visual.similarity) ? page.visual.similarity : null,
      mismatch: Number.isFinite(page.visual.similarity) && page.visual.similarity < VISUAL_MATCH_THRESHOLD,
      error: page.visual.error || null
    }))
    .sort((a, b) => (a.similarity ?? 2) - (b.similarity ?? 2));
}

export async function visualComparison(store, archiveId, pageUrl = '') {
  const audit = await store.readReplayAudit(archiveId);
  if (!audit) return { available: false, pages: [], page: null, threshold: VISUAL_MATCH_THRESHOLD };
  const pages = visualPages(audit);
  const source = pageUrl ? (audit.pages || []).find((page) => page.url === pageUrl && page.visual) : (audit.pages || []).find((page) => page.visual?.replay);
  return {
    available: pages.length > 0, auditedAt: audit.completedAt || null, threshold: VISUAL_MATCH_THRESHOLD, pages: pages.slice(0, 200),
    page: source ? { url: source.url, title: source.title || source.savedTitle || '', ...source.visual } : null
  };
}
