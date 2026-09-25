import { logEvent, safeUrl } from './logger.mjs';

export const DEFAULT_MEDIA_MAX_BYTES = 2 * 1024 ** 3;
const HLS_TYPE = /mpegurl/i;
const DASH_TYPE = /dash\+xml/i;
const SEGMENT_TEMPLATE = /<SegmentTemplate\b[^>]*\/>|<SegmentTemplate\b[^>]*>[\s\S]*?<\/SegmentTemplate>/i;

function headerValue(headers = {}, name) {
  if (headers instanceof Headers) return headers.get(name) || '';
  const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}

function plainHeaders(headers) {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function resolveUrl(value, base) {
  try {
    const url = new URL(String(value).trim(), base);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function isHlsPlaylist(resource) {
  return HLS_TYPE.test(resource.mimeType || headerValue(resource.headers, 'content-type')) || /\.m3u8(?:[?#]|$)/i.test(resource.url || '');
}

export function isDashManifest(resource) {
  return DASH_TYPE.test(resource.mimeType || headerValue(resource.headers, 'content-type')) || /\.mpd(?:[?#]|$)/i.test(resource.url || '');
}

export function isMediaFile(resource) {
  if (isHlsPlaylist(resource) || isDashManifest(resource)) return false;
  const type = resource.mimeType || headerValue(resource.headers, 'content-type');
  return resource.type === 'Media' || /^(?:video|audio)\//i.test(type);
}

export function totalFromContentRange(value = '') {
  const match = String(value).match(/\/\s*(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

export function needsFullMedia(resource) {
  if (!isMediaFile(resource) || !/^https?:/i.test(resource.url || '')) return false;
  const range = headerValue(resource.headers, 'content-range');
  if (resource.status === 206 || range) return true;
  const declared = Number(headerValue(resource.headers, 'content-length') || 0);
  return !resource.body?.length || (declared > 0 && resource.body.length < declared);
}

export function parseHlsPlaylist(text, baseUrl) {
  const playlists = [];
  const segments = [];
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim());
  let nextIsVariant = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF/i.test(line)) nextIsVariant = true;
      const uri = line.match(/\bURI="([^"]+)"/i)?.[1];
      if (uri) {
        const target = resolveUrl(uri, baseUrl);
        if (target) (/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF)/i.test(line) ? playlists : segments).push(target);
      }
      continue;
    }
    const target = resolveUrl(line, baseUrl);
    if (!target) continue;
    if (nextIsVariant || /\.m3u8(?:[?#]|$)/i.test(target)) playlists.push(target);
    else segments.push(target);
    nextIsVariant = false;
  }
  return { playlists: [...new Set(playlists)], segments: [...new Set(segments)] };
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'))?.[1] ?? null;
}

function isoDurationSeconds(value) {
  const match = String(value || '').match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match.map((item) => Number(item || 0));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function fillTemplate(template, values) {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth)(?:%0(\d+)d)?\$/g, (_match, key, width) => {
    const value = String(values[key] ?? '');
    return width ? value.padStart(Number(width), '0') : value;
  }).replaceAll('$$', '$');
}

function baseUrlWithin(block, base) {
  const value = block.match(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/i)?.[1];
  return value ? resolveUrl(value.trim(), base) || base : base;
}

export function parseDashManifest(text, baseUrl, { maxSegments = 200000 } = {}) {
  const xml = String(text || '');
  const segments = [];
  const mpdTag = xml.match(/<MPD\b[^>]*>/i)?.[0] || '';
  const totalSeconds = isoDurationSeconds(attribute(mpdTag, 'mediaPresentationDuration'));
  const mpdBase = baseUrlWithin(xml.replace(/<Period[\s\S]*$/i, ''), baseUrl);
  const periods = [...xml.matchAll(/<Period\b[\s\S]*?<\/Period>/gi)].map((match) => match[0]);
  for (const period of periods.length ? periods : [xml]) {
    const periodBase = baseUrlWithin(period.replace(/<AdaptationSet[\s\S]*$/i, ''), mpdBase);
    const periodSeconds = isoDurationSeconds(attribute(period.match(/<Period\b[^>]*>/i)?.[0] || '', 'duration')) ?? totalSeconds;
    for (const adaptationMatch of period.matchAll(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/gi)) {
      const adaptation = adaptationMatch[0];
      const adaptationBase = baseUrlWithin(adaptation.replace(/<Representation[\s\S]*$/i, ''), periodBase);
      const sharedTemplate = adaptation.replace(/<Representation[\s\S]*$/i, '').match(SEGMENT_TEMPLATE)?.[0] || null;
      const representations = [...adaptation.matchAll(/<Representation\b[^>]*\/>|<Representation\b[^>]*>[\s\S]*?<\/Representation>/gi)].map((match) => match[0]);
      for (const representation of representations) {
        const repTag = representation.match(/<Representation\b[^>]*>/i)?.[0] || representation;
        const values = { RepresentationID: attribute(repTag, 'id') || '', Bandwidth: attribute(repTag, 'bandwidth') || '' };
        const repBase = baseUrlWithin(representation, adaptationBase);
        const list = representation.match(/<SegmentList\b[\s\S]*?<\/SegmentList>/i)?.[0];
        if (list) {
          const init = list.match(/<Initialization\b[^>]*>/i)?.[0];
          if (init && attribute(init, 'sourceURL')) segments.push(resolveUrl(attribute(init, 'sourceURL'), repBase));
          for (const segment of list.matchAll(/<SegmentURL\b[^>]*>/gi)) {
            const media = attribute(segment[0], 'media');
            if (media) segments.push(resolveUrl(media, repBase));
          }
          continue;
        }
        const template = representation.match(SEGMENT_TEMPLATE)?.[0] || sharedTemplate;
        if (!template) {
          if (representation.match(/<BaseURL/i)) segments.push(repBase);
          continue;
        }
        const templateTag = template.match(/<SegmentTemplate\b[^>]*>/i)?.[0] || template;
        const media = attribute(templateTag, 'media');
        const initialization = attribute(templateTag, 'initialization');
        if (initialization) segments.push(resolveUrl(fillTemplate(initialization, values), repBase));
        if (!media) continue;
        const timescale = Number(attribute(templateTag, 'timescale') || 1);
        let number = Number(attribute(templateTag, 'startNumber') ?? 1);
        const timeline = template.match(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/i)?.[1];
        if (timeline) {
          let time = 0;
          for (const entry of timeline.matchAll(/<S\b[^>]*>/gi)) {
            const duration = Number(attribute(entry[0], 'd') || 0);
            if (attribute(entry[0], 't') !== null) time = Number(attribute(entry[0], 't'));
            const repeat = Number(attribute(entry[0], 'r') || 0);
            for (let index = 0; index <= Math.max(0, repeat); index += 1) {
              segments.push(resolveUrl(fillTemplate(media, { ...values, Number: number, Time: time }), repBase));
              number += 1; time += duration;
              if (segments.length >= maxSegments) break;
            }
          }
          continue;
        }
        const segmentDuration = Number(attribute(templateTag, 'duration') || 0) / timescale;
        if (!segmentDuration || !periodSeconds) continue;
        const count = Math.min(maxSegments, Math.ceil(periodSeconds / segmentDuration));
        for (let index = 0; index < count; index += 1) segments.push(resolveUrl(fillTemplate(media, { ...values, Number: number + index }), repBase));
      }
    }
  }
  return { playlists: [], segments: [...new Set(segments.filter(Boolean))] };
}

function limitLabel(bytes) {
  if (bytes === null) return '無制限';
  if (bytes >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function mediaLimitReason(limitBytes) {
  return `動画・音声が1件の上限（${limitLabel(limitBytes)}）を超えるため未保存です。アーカイブ画面からあとで保存できます。`;
}

async function fetchBody(fetcher, url, options, limitBytes) {
  const { response, finalUrl } = await fetcher(url, { ...options, responseMaxBytes: limitBytes });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  return { response, finalUrl, body };
}

function isLimitError(error) {
  return /取得上限を超え/.test(error?.message || '');
}

export const BACKGROUND_MEDIA_REASON = '動画・音声は別の流れで後から保存します。';

export async function completeMediaResources(capture, options = {}, fetcher, diagnostic = {}) {
  const limitBytes = options.mediaMaxBytes === null ? null : Number(options.mediaMaxBytes ?? DEFAULT_MEDIA_MAX_BYTES);
  const background = options.mediaStrategy === 'background';
  const resources = capture.resources || [];
  const known = new Set([...resources.filter((item) => item.status < 400 && item.body?.length).map((item) => item.url), ...(options.knownResourceUrls || [])]);
  const deferred = [];
  const failures = [];
  let completedFiles = 0;
  let savedSegments = 0;

  for (const resource of resources.filter(needsFullMedia)) {
    if (options.signal?.aborted) break;
    const total = totalFromContentRange(headerValue(resource.headers, 'content-range'));
    if (limitBytes !== null && total !== null && total > limitBytes) {
      deferred.push({ url: resource.url, kind: 'file', expectedBytes: total, limitBytes, reason: mediaLimitReason(limitBytes) });
      continue;
    }
    if (background) {
      deferred.push({ url: resource.url, kind: 'file', expectedBytes: total, limitBytes, background: true, reason: BACKGROUND_MEDIA_REASON });
      continue;
    }
    try {
      const { response, finalUrl, body } = await fetchBody(fetcher, resource.url, options, limitBytes);
      if (!body.length) throw new Error('取得した応答が空でした。');
      resource.status = response.status;
      resource.headers = plainHeaders(response.headers);
      resource.mimeType = headerValue(response.headers, 'content-type') || resource.mimeType;
      resource.body = body;
      delete resource.bodyCharset;
      if (finalUrl !== resource.url) resource.aliases = [...new Set([...(resource.aliases || []), finalUrl])];
      known.add(resource.url);
      completedFiles += 1;
    } catch (error) {
      if (isLimitError(error)) deferred.push({ url: resource.url, kind: 'file', expectedBytes: total, limitBytes, reason: mediaLimitReason(limitBytes) });
      else failures.push({ url: resource.url, reason: `動画・音声の全体を取得できません: ${error.message}` });
    }
  }

  const streamQueue = resources.filter((item) => (isHlsPlaylist(item) || isDashManifest(item)) && item.body?.length && item.status < 400)
    .map((item) => ({ url: item.url, body: item.body, dash: isDashManifest(item), root: item.url }));
  const streamBytes = new Map();
  const seenPlaylists = new Set(streamQueue.map((item) => item.url));
  const deferredStreams = new Map();
  while (streamQueue.length && !options.signal?.aborted) {
    const playlist = streamQueue.shift();
    const parsed = playlist.dash
      ? parseDashManifest(playlist.body.toString('utf8'), playlist.url)
      : parseHlsPlaylist(playlist.body.toString('utf8'), playlist.url);
    for (const child of parsed.playlists) {
      if (seenPlaylists.has(child)) continue;
      seenPlaylists.add(child);
      try {
        const { response, finalUrl, body } = await fetchBody(fetcher, child, options, 32 * 1024 ** 2);
        resources.push({ url: child, aliases: finalUrl !== child ? [finalUrl] : [], status: response.status, headers: plainHeaders(response.headers), mimeType: headerValue(response.headers, 'content-type') || 'application/vnd.apple.mpegurl', type: 'Media', body });
        known.add(child);
        streamQueue.push({ url: child, body, dash: false, root: playlist.root });
      } catch (error) {
        failures.push({ url: child, reason: `配信リストを取得できません: ${error.message}` });
      }
    }
    for (const segment of parsed.segments) {
      if (known.has(segment) || options.signal?.aborted) continue;
      const pending = deferredStreams.get(playlist.root);
      if (pending) { pending.remainingUrls.push(segment); continue; }
      const used = streamBytes.get(playlist.root) || 0;
      const remaining = limitBytes === null ? null : limitBytes - used;
      if (background) {
        deferredStreams.set(playlist.root, { url: playlist.root, kind: 'stream', limitBytes, savedBytes: used, remainingUrls: [segment], background: true, reason: BACKGROUND_MEDIA_REASON });
        continue;
      }
      if (remaining !== null && remaining <= 0) {
        deferredStreams.set(playlist.root, { url: playlist.root, kind: 'stream', limitBytes, savedBytes: used, remainingUrls: [segment], reason: mediaLimitReason(limitBytes) });
        continue;
      }
      try {
        const { response, finalUrl, body } = await fetchBody(fetcher, segment, options, remaining);
        resources.push({ url: segment, aliases: finalUrl !== segment ? [finalUrl] : [], status: response.status, headers: plainHeaders(response.headers), mimeType: headerValue(response.headers, 'content-type') || 'video/mp2t', type: 'Media', body });
        known.add(segment);
        streamBytes.set(playlist.root, used + body.length);
        savedSegments += 1;
      } catch (error) {
        if (isLimitError(error)) deferredStreams.set(playlist.root, { url: playlist.root, kind: 'stream', limitBytes, savedBytes: used, remainingUrls: [segment], reason: mediaLimitReason(limitBytes) });
        else failures.push({ url: segment, reason: `配信の分割ファイルを取得できません: ${error.message}` });
      }
    }
  }
  deferred.push(...deferredStreams.values());

  capture.deferredMedia = [...(capture.deferredMedia || []), ...deferred];
  capture.blocked ||= [];
  capture.blocked.push(...failures, ...deferred.filter((item) => !item.background).map((item) => ({ url: item.url, reason: item.reason })));
  if (completedFiles || savedSegments || deferred.length || failures.length) {
    logEvent(failures.length ? 'warn' : 'info', 'capture', 'media.completion', {
      ...diagnostic, completedFiles, savedSegments, deferred: deferred.length, failed: failures.length,
      limitBytes, deferredUrls: deferred.slice(0, 20).map((item) => safeUrl(item.url))
    });
  }
  return capture;
}
