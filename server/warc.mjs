import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);

function record(headers, payload) {
  const block = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const digest = crypto.createHash('sha256').update(block).digest('base64');
  const lines = [
    'WARC/1.1',
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    `WARC-Block-Digest: sha256:${digest}`,
    `Content-Length: ${block.length}`,
    '', ''
  ];
  return Buffer.concat([Buffer.from(lines.join('\r\n')), block, Buffer.from('\r\n\r\n')]);
}

function warcPayload(records, metadata) {
  const now = new Date().toISOString();
  const chunks = [record({
    'WARC-Type': 'warcinfo', 'WARC-Date': now, 'WARC-Record-ID': `<urn:uuid:${crypto.randomUUID()}>`,
    'Content-Type': 'application/warc-fields'
  }, `software: WebCapture/4.1.0\r\nformat: WARC File Format 1.1\r\njson-metadata: ${JSON.stringify(metadata)}\r\n`)];
  for (const item of records) {
    const responseId = `<urn:uuid:${crypto.randomUUID()}>`;
    chunks.push(record({
      'WARC-Type': 'response', 'WARC-Target-URI': item.url, 'WARC-Date': item.capturedAt || now,
      'WARC-Record-ID': responseId, 'Content-Type': 'application/http; msgtype=response'
    }, item.httpPayload));
    if (item.requestPayload) chunks.push(record({
      'WARC-Type': 'request', 'WARC-Target-URI': item.url, 'WARC-Date': item.capturedAt || now,
      'WARC-Record-ID': `<urn:uuid:${crypto.randomUUID()}>`, 'WARC-Concurrent-To': responseId,
      'Content-Type': 'application/http; msgtype=request'
    }, item.requestPayload));
  }
  return Buffer.concat(chunks);
}

function gzipOptions(compressionLevel) {
  return { level: Math.min(9, Math.max(0, Number(compressionLevel) || 0)) };
}

export function createWarc(records, metadata = {}, compressionLevel = 1) {
  return zlib.gzipSync(warcPayload(records, metadata), gzipOptions(compressionLevel));
}

export async function createWarcAsync(records, metadata = {}, compressionLevel = 1) {
  return gzip(warcPayload(records, metadata), gzipOptions(compressionLevel));
}
