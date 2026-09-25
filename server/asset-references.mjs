import { normalizeUrl } from './policy.mjs';
import { parseSrcset } from './srcset.mjs';
import { isAuxiliaryRuntimeUrl, isServerBoundaryUrl } from './quality.mjs';

export const IMAGE_SOURCE_ATTRIBUTES = Object.freeze(['data_max_resolution', 'data-max-resolution', 'data-original', 'data-zoom-src', 'data-zoom-image', 'data-large-image', 'data-large_image', 'data-full-src']);

function decode(value) {
  return String(value).replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&quot;/gi, '"');
}

function addReference(output, value, baseUrl) {
  if (!value || /^(?:data:|blob:|about:|javascript:|#)/i.test(value)) return;
  try { output.add(normalizeUrl(decode(value), baseUrl)); } catch {}
}

export function cssAssetReferences(source, baseUrl) {
  const output = new Set();
  for (const match of String(source).matchAll(/url\(\s*(["']?)([^)"']+)\1\s*\)|@import\s*(["'])(.*?)\3/gi)) addReference(output, match[2] || match[4], baseUrl);
  return [...output];
}

export function htmlAssetReferences(source, baseUrl) {
  baseUrl = documentBaseUrl(source, baseUrl);
  const output = new Set();
  const html = String(source).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, match => match.slice(0, match.indexOf('>') + 1));
  for (const tag of html.matchAll(/<([a-z][a-z0-9:-]*)\b([^<>]*?)>/gi)) {
    const tagName = tag[1].toLowerCase();
    const attributes = new Map();
    for (const attribute of tag[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) attributes.set(attribute[1].toLowerCase(), attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    for (const name of ['src', 'poster', 'data-src']) addReference(output, attributes.get(name), baseUrl);
    if (['img', 'source'].includes(tagName)) for (const name of IMAGE_SOURCE_ATTRIBUTES) addReference(output, attributes.get(name), baseUrl);
    if (tagName === 'link' && /(?:stylesheet|preload|modulepreload|icon)/i.test(attributes.get('rel') || '')) addReference(output, attributes.get('href'), baseUrl);
    for (const name of ['srcset', 'data-srcset']) {
      const value = attributes.get(name) || '';
      for (const { url } of parseSrcset(value)) addReference(output, url, baseUrl);
    }
    for (const url of cssAssetReferences(decode(attributes.get('style') || ''), baseUrl)) output.add(url);
  }
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) for (const url of cssAssetReferences(style[1], baseUrl)) output.add(url);
  return [...output];
}

export function referenceAudit(references, knownResources, aliases = {}) {
  const known = knownResources instanceof Set ? knownResources : new Set(Object.keys(knownResources || {}));
  const unique = [...new Set(references)];
  const completeTypekitFonts = new Set();
  for (const value of known) {
    try {
      const url = new URL(value);
      if (url.hostname === 'use.typekit.net' && url.pathname.startsWith('/af/') && url.searchParams.get('chunks') === '0') {
        completeTypekitFonts.add(`${url.origin}${url.pathname}`);
      }
    } catch {}
  }
  const fallbackResolved = [];
  const serverBoundaries = [];
  const auxiliaryReferences = [];
  const missing = unique.filter((value) => {
    if (known.has(value) || known.has(aliases[value])) return false;
    if (isServerBoundaryUrl(value)) { serverBoundaries.push(value); return false; }
    if (isAuxiliaryRuntimeUrl(value)) { auxiliaryReferences.push(value); return false; }
    try {
      const url = new URL(value);
      if (url.hostname === 'use.typekit.net' && url.pathname.startsWith('/af/') && completeTypekitFonts.has(`${url.origin}${url.pathname}`)) {
        fallbackResolved.push(value);
        return false;
      }
    } catch {}
    return true;
  });
  return {
    checkedCount: unique.length,
    missingCount: missing.length,
    missing,
    fallbackResolvedCount: fallbackResolved.length,
    fallbackResolved,
    serverBoundaryCount: serverBoundaries.length,
    serverBoundaries,
    auxiliaryCount: auxiliaryReferences.length,
    auxiliaryReferences,
    checkedAt: new Date().toISOString()
  };
}

export function documentBaseUrl(source, pageUrl) {
  const value = String(source).match(/<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  try { return value ? normalizeUrl(decode(value[1] ?? value[2] ?? value[3] ?? ''), pageUrl) : pageUrl; }
  catch { return pageUrl; }
}
