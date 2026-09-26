import './env-compat.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CAPTURE_OPTIONS } from './capture-options.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function appConfigParentOrigins() {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.config.json'), 'utf8')).iframeParentOrigins;
    return Array.isArray(value) ? value.filter((origin) => /^https?:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin)) : [];
  } catch { return []; }
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export const CONFIG = Object.freeze({
  projectRoot,
  publicRoot: path.join(projectRoot, 'public'),
  dataRoot: process.env.WEBCAPTURE_DATA_ROOT
    ? path.resolve(process.env.WEBCAPTURE_DATA_ROOT)
    : path.join(projectRoot, 'data'),
  metricsRoot: process.env.WEBCAPTURE_METRICS_ROOT
    ? path.resolve(process.env.WEBCAPTURE_METRICS_ROOT)
    : path.join(projectRoot, 'runtime', 'metrics'),
  host: '127.0.0.1',
  port: Number(process.env.WEBCAPTURE_PORT || 43193),
  replayPort: Number(process.env.WEBCAPTURE_REPLAY_PORT || 43194),
  iframeParentOrigins: Object.freeze(appConfigParentOrigins()),
  appName: 'WebCapture',
  version: '4.1.0',
  metricsIntervalMs: boundedInteger(process.env.WEBCAPTURE_METRICS_INTERVAL_MS, 5000, 1000, 60000),
  globalCaptureConcurrency: boundedInteger(process.env.WEBCAPTURE_GLOBAL_CAPTURE_CONCURRENCY, 30, 1, 64),
  globalDiscoveryConcurrency: boundedInteger(process.env.WEBCAPTURE_GLOBAL_DISCOVERY_CONCURRENCY, 256, 1, 512),
  defaultLimits: DEFAULT_CAPTURE_OPTIONS
});

export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
});
