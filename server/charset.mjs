const TEXT_TYPE = /^(?:text\/|application\/(?:javascript|ecmascript|json|ld\+json|xml|xhtml\+xml|rss\+xml|atom\+xml|manifest\+json)|image\/svg\+xml)/i;

export function isTextualType(type = '') {
  return TEXT_TYPE.test(String(type).trim());
}

export function normalizeCharset(label) {
  if (!label) return null;
  try { return new TextDecoder(String(label).trim().replace(/^["']|["']$/g, '')).encoding; } catch { return null; }
}

export function charsetFromContentType(value = '') {
  const match = String(value).match(/;\s*charset\s*=\s*("?)([^";\s]+)\1/i);
  return normalizeCharset(match?.[2]);
}

function charsetFromBom(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16be';
  return null;
}

function charsetFromMarkup(buffer, type) {
  const head = buffer.subarray(0, 4096).toString('latin1');
  if (/html|xml/i.test(type) || /^\s*</.test(head)) {
    const meta = head.match(/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i)
      || head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([\w.:-]+)/i)
      || head.match(/<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i);
    if (meta) return normalizeCharset(meta[1]);
  }
  if (/css/i.test(type)) {
    const rule = head.match(/^@charset\s+["']([\w.:-]+)["']/i);
    if (rule) return normalizeCharset(rule[1]);
  }
  return null;
}

export function detectCharset({ contentType = '', body = Buffer.alloc(0) } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  return charsetFromBom(buffer)
    || charsetFromContentType(contentType)
    || charsetFromMarkup(buffer, contentType)
    || 'utf-8';
}

export function decodeText(buffer, charset = 'utf-8') {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  try { return new TextDecoder(normalizeCharset(charset) || 'utf-8').decode(input); }
  catch { return new TextDecoder('utf-8').decode(input); }
}

function validUtf8(buffer) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return true; } catch { return false; }
}

export function storedTextCharset(buffer, resource = {}) {
  const recorded = normalizeCharset(resource.charset || resource.bodyCharset);
  if (recorded) return recorded;
  const contentType = resource.headers?.['content-type'] || resource.mimeType || '';
  const detected = detectCharset({ contentType, body: buffer });
  if (detected === 'utf-8' || validUtf8(buffer)) return 'utf-8';
  return detected;
}

export function decodeStoredText(buffer, resource = {}) {
  return decodeText(buffer, storedTextCharset(buffer, resource));
}

export function withCharset(contentType = '', charset = 'utf-8') {
  const base = String(contentType || '').split(';').map((part) => part.trim()).filter((part) => part && !/^charset\s*=/i.test(part));
  if (!base.length) return contentType;
  return `${base.join('; ')}; charset=${charset}`;
}
