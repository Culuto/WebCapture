import { isAuxiliaryRuntimeUrl } from './quality.mjs';

const NOISE_HOST = /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com|googleadservices\.com|googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|analytics\.tiktok\.com|ads-twitter\.com|ads-api\.twitter\.com|analytics\.twitter\.com|criteo\.(?:com|net)|taboola\.com|outbrain\.com|adnxs\.com|amazon-adsystem\.com|scorecardresearch\.com|quantserve\.com|adsrvr\.org|rubiconproject\.com|pubmatic\.com|casalemedia\.com|moatads\.com|yieldmo\.com|appier\.net|ladsp\.com|microad\.jp|i-mobile\.co\.jp|logly\.co\.jp|popin\.cc|karte\.io|treasuredata\.com|newrelic\.com|fullstory\.com|mouseflow\.com|heapanalytics\.com|amplitude\.com|branch\.io|appsflyer\.com|adjust\.com)$/i;
const NOISE_HOST_PATH = /^(?:(?:[a-z0-9-]+\.)*facebook\.com\/tr\/?|play\.google\.com\/log)$/i;
const NOISE_PATH = /(?:\/api\/stats\/(?:watchtime|playback|qoe|atr|delayplay|ads)|\/youtubei\/v1\/log_event|\/generate_204|\/csi_204|\/ptracking|\/pagead\/|\/i\/api\/1\.1\/jot\/|\/1\.1\/jot\/|\/\.well-known\/shopify\/monorail|\/api\/collect)/i;
const NOISE_TYPES = new Set(['ping', 'cspviolationreport']);

export function isCaptureNoise(url, resourceType = '') {
  if (NOISE_TYPES.has(String(resourceType).toLowerCase())) return true;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (isAuxiliaryRuntimeUrl(parsed.href)) return true;
  if (NOISE_HOST.test(parsed.hostname)) return true;
  if (NOISE_HOST_PATH.test(`${parsed.hostname}${parsed.pathname}`)) return true;
  return NOISE_PATH.test(parsed.pathname);
}
