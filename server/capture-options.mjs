const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

export const RESOURCE_TYPE_KEYS = Object.freeze(['stylesheet', 'script', 'image', 'media', 'font', 'xhr', 'other']);

export const DEFAULT_CAPTURE_OPTIONS = Object.freeze({
  maxPages: 10000,
  maxBytes: 50 * GiB,
  maxDurationMs: 12 * 60 * 60 * 1000,
  sameSiteKeywords: [],
  discoveryMode: 'partial',
  discoveryPageLimit: 100,
  discoveryConcurrency: 4,
  sameSiteWarningDepth: 30,
  sameSiteMaxDepth: 1000,
  externalWarningDepth: 5,
  externalMaxDepth: 1,
  concurrency: 2,
  requestTimeoutMs: 30000,
  loadWaitMs: 30000,
  finalizeGraceMs: 45000,
  responseMaxBytes: 256 * MiB,
  mediaMaxBytes: 2 * GiB,
  pageMaxBytes: 2 * GiB,
  maxRedirects: 8,
  maxLinksPerPage: 5000,
  maxResourcesPerPage: 5000,
  queryPolicy: 'keep',
  includeUrlPatterns: [],
  excludeUrlPatterns: [],
  resourceTypes: Object.freeze({ stylesheet: true, script: true, image: true, media: true, font: true, xhr: true, other: true }),
  screenshotMode: 'viewport',
  warcEnabled: true,
  warcCompressionLevel: 1,
  browserReuse: true,
  disableBrowserCache: false,
  viewportWidth: 1440,
  viewportHeight: 1000,
  deviceScaleFactor: 1,
  initialWaitMs: 300,
  networkIdleMs: 1000,
  networkIdleMaxMs: 15000,
  scrollEnabled: true,
  scrollDelayMs: 120,
  scrollStepRatio: 0.75,
  maxScrollContainers: 20,
  maxScrollStepsPerContainer: 100,
  imageWaitMs: 5000,
  interactDuringCapture: true,
  interactionMaxMs: 60000,
  interactionSettleMs: 120,
  maxInteractionsPerPage: 250,
  hoverDuringCapture: true,
  hoverMaxMs: 30000,
  maxHoversPerPage: 80,
  preserveShadowDom: true,
  preserveCanvas: true,
  preserveFormState: true,
  freezeResponsiveImages: true,
  captureSrcsetCandidates: false,
  maxSrcsetCandidates: 1000
});

const TRACKING_QUERY_KEYS = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|ref|referrer|source)$/i;

function numeric(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function integer(value, fallback, min, max) {
  return Math.trunc(numeric(value, fallback, min, max));
}

function unlimited(value) {
  return value === null || value === 'unlimited' || value === 'none';
}

function nullableNumeric(value, fallback, min, max) {
  return unlimited(value) ? null : numeric(value, fallback, min, max);
}

function nullableInteger(value, fallback, min, max) {
  return unlimited(value) ? null : integer(value, fallback, min, max);
}

function boolean(value, fallback) {
  return value === undefined ? fallback : value === true || value === 'true' || value === 1;
}

function stringList(value, maxItems = 50) {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n|,/) : [];
  return [...new Set(input.map((item) => String(item).trim()).filter(Boolean))]
    .filter((item) => item.length <= 200 && !/[\u0000-\u001f]/.test(item))
    .slice(0, maxItems);
}

export function sanitizeCaptureOptions(input = {}, defaults = DEFAULT_CAPTURE_OPTIONS, validateKeywords = (value) => value || []) {
  const discoveryMode = ['immediate', 'complete', 'partial', 'separate'].includes(input.discoveryMode) ? input.discoveryMode : defaults.discoveryMode;
  const queryPolicy = ['keep', 'drop-tracking', 'drop-all'].includes(input.queryPolicy) ? input.queryPolicy : defaults.queryPolicy;
  const screenshotMode = ['none', 'viewport', 'full-page'].includes(input.screenshotMode) ? input.screenshotMode : defaults.screenshotMode;
  const resourceInput = input.resourceTypes && typeof input.resourceTypes === 'object' ? input.resourceTypes : {};
  const resourceTypes = Object.fromEntries(RESOURCE_TYPE_KEYS.map((key) => [key, boolean(resourceInput[key], defaults.resourceTypes[key])]));
  return {
    followExternal: boolean(input.followExternal, false),
    respectRobots: boolean(input.respectRobots, true),
    captureRendered: boolean(input.captureRendered, true),
    sameSiteKeywords: validateKeywords(input.sameSiteKeywords),
    discoveryMode,
    discoveryPageLimit: integer(input.discoveryPageLimit, defaults.discoveryPageLimit, 10, 100000),
    discoveryConcurrency: integer(input.discoveryConcurrency, defaults.discoveryConcurrency, 1, 256),
    discoveryMethod: input.discoveryMethod === 'browser' ? 'browser' : 'http',
    mediaStrategy: input.mediaStrategy === 'inline' ? 'inline' : input.mediaStrategy === 'background' ? 'background' : (defaults.mediaStrategy || 'inline'),
    mediaSpeed: ['slow', 'normal', 'fast'].includes(input.mediaSpeed) ? input.mediaSpeed : 'normal',
    maxPages: nullableInteger(input.maxPages, defaults.maxPages, 1, Number.MAX_SAFE_INTEGER),
    maxBytes: nullableNumeric(input.maxBytes, defaults.maxBytes, 10 * MiB, Number.MAX_SAFE_INTEGER),
    maxDurationMs: nullableNumeric(input.maxDurationMs, defaults.maxDurationMs, 60000, Number.MAX_SAFE_INTEGER),
    sameSiteWarningDepth: nullableInteger(input.sameSiteWarningDepth, defaults.sameSiteWarningDepth, 1, Number.MAX_SAFE_INTEGER),
    sameSiteMaxDepth: nullableInteger(input.sameSiteMaxDepth, defaults.sameSiteMaxDepth, 0, Number.MAX_SAFE_INTEGER),
    externalWarningDepth: nullableInteger(input.externalWarningDepth, defaults.externalWarningDepth, 1, Number.MAX_SAFE_INTEGER),
    externalMaxDepth: nullableInteger(input.externalMaxDepth, defaults.externalMaxDepth, 0, Number.MAX_SAFE_INTEGER),
    concurrency: integer(input.concurrency, defaults.concurrency, 1, 30),
    optimize: boolean(input.optimize, false),
    blockTrackers: boolean(input.blockTrackers, true),
    distributedAccess: boolean(input.distributedAccess, true),
    autoExcludeAccountPages: boolean(input.autoExcludeAccountPages, true),
    externalDetail: ['full', 'standard', 'light'].includes(input.externalDetail) ? input.externalDetail : 'full',
    repairBeforeComplete: boolean(input.repairBeforeComplete, true),
    sharePages: boolean(input.sharePages, true),
    captureMobile: boolean(input.captureMobile, false),
    prefetchScripts: boolean(input.prefetchScripts, true),
    loginProfileId: typeof input.loginProfileId === 'string' && /^login_[a-z0-9_]+$/i.test(input.loginProfileId) ? input.loginProfileId : null,
    perHostConcurrency: unlimited(input.perHostConcurrency) ? 0 : integer(input.perHostConcurrency, defaults.perHostConcurrency ?? 2, 0, 30),
    perHostIntervalMs: integer(input.perHostIntervalMs, defaults.perHostIntervalMs ?? 1000, 0, 60000),
    pageRetries: integer(input.pageRetries, defaults.pageRetries ?? 2, 0, 5),
    requestTimeoutMs: integer(input.requestTimeoutMs, defaults.requestTimeoutMs, 3000, 6 * 60 * 60 * 1000),
    loadWaitMs: integer(input.loadWaitMs, defaults.loadWaitMs, 1000, 600000),
    finalizeGraceMs: integer(input.finalizeGraceMs, defaults.finalizeGraceMs, 5000, 600000),
    responseMaxBytes: nullableNumeric(input.responseMaxBytes, defaults.responseMaxBytes, 1 * MiB, Number.MAX_SAFE_INTEGER),
    mediaMaxBytes: nullableNumeric(input.mediaMaxBytes, defaults.mediaMaxBytes, 16 * MiB, Number.MAX_SAFE_INTEGER),
    pageMaxBytes: nullableNumeric(input.pageMaxBytes, defaults.pageMaxBytes, 10 * MiB, Number.MAX_SAFE_INTEGER),
    maxRedirects: nullableInteger(input.maxRedirects, defaults.maxRedirects, 0, Number.MAX_SAFE_INTEGER),
    maxLinksPerPage: nullableInteger(input.maxLinksPerPage, defaults.maxLinksPerPage, 1, Number.MAX_SAFE_INTEGER),
    maxResourcesPerPage: nullableInteger(input.maxResourcesPerPage, defaults.maxResourcesPerPage, 1, Number.MAX_SAFE_INTEGER),
    queryPolicy,
    includeUrlPatterns: stringList(input.includeUrlPatterns),
    excludeUrlPatterns: stringList(input.excludeUrlPatterns),
    resourceTypes,
    screenshotMode,
    warcEnabled: boolean(input.warcEnabled, defaults.warcEnabled),
    warcCompressionLevel: integer(input.warcCompressionLevel, defaults.warcCompressionLevel, 0, 9),
    browserReuse: boolean(input.browserReuse, defaults.browserReuse),
    disableBrowserCache: boolean(input.disableBrowserCache, defaults.disableBrowserCache),
    viewportWidth: integer(input.viewportWidth, defaults.viewportWidth, 320, 3840),
    viewportHeight: integer(input.viewportHeight, defaults.viewportHeight, 320, 2160),
    deviceScaleFactor: numeric(input.deviceScaleFactor, defaults.deviceScaleFactor, 0.5, 3),
    initialWaitMs: integer(input.initialWaitMs, defaults.initialWaitMs, 0, 30000),
    networkIdleMs: integer(input.networkIdleMs, defaults.networkIdleMs, 0, 30000),
    networkIdleMaxMs: integer(input.networkIdleMaxMs, defaults.networkIdleMaxMs, 0, 600000),
    scrollEnabled: boolean(input.scrollEnabled, defaults.scrollEnabled),
    scrollDelayMs: integer(input.scrollDelayMs, defaults.scrollDelayMs, 0, 5000),
    scrollStepRatio: numeric(input.scrollStepRatio, defaults.scrollStepRatio, 0.1, 2),
    maxScrollContainers: nullableInteger(input.maxScrollContainers, defaults.maxScrollContainers, 1, Number.MAX_SAFE_INTEGER),
    maxScrollStepsPerContainer: nullableInteger(input.maxScrollStepsPerContainer, defaults.maxScrollStepsPerContainer, 1, Number.MAX_SAFE_INTEGER),
    imageWaitMs: integer(input.imageWaitMs, defaults.imageWaitMs, 0, 300000),
    interactDuringCapture: boolean(input.interactDuringCapture, defaults.interactDuringCapture),
    interactionMaxMs: integer(input.interactionMaxMs, defaults.interactionMaxMs, 1000, 600000),
    interactionSettleMs: integer(input.interactionSettleMs, defaults.interactionSettleMs, 0, 5000),
    maxInteractionsPerPage: input.maxInteractionsPerPage === null || input.maxInteractionsPerPage === 'unlimited' ? null : integer(input.maxInteractionsPerPage, defaults.maxInteractionsPerPage, 1, 100000),
    interactionMode: input.interactionMode === 'representative' ? 'representative' : 'all',
    hoverDuringCapture: boolean(input.hoverDuringCapture, defaults.hoverDuringCapture),
    hoverMaxMs: integer(input.hoverMaxMs, defaults.hoverMaxMs, 1000, 600000),
    maxHoversPerPage: integer(input.maxHoversPerPage, defaults.maxHoversPerPage, 1, 2000),
    preserveShadowDom: boolean(input.preserveShadowDom, defaults.preserveShadowDom),
    preserveCanvas: boolean(input.preserveCanvas, defaults.preserveCanvas),
    preserveFormState: boolean(input.preserveFormState, defaults.preserveFormState),
    freezeResponsiveImages: boolean(input.freezeResponsiveImages, defaults.freezeResponsiveImages),
    captureSrcsetCandidates: boolean(input.captureSrcsetCandidates, defaults.captureSrcsetCandidates),
    maxSrcsetCandidates: nullableInteger(input.maxSrcsetCandidates, defaults.maxSrcsetCandidates, 0, Number.MAX_SAFE_INTEGER)
  };
}

export function applyQueryPolicy(value, policy = 'keep') {
  const url = new URL(value);
  if (policy === 'drop-all') url.search = '';
  if (policy === 'drop-tracking') {
    for (const key of [...url.searchParams.keys()]) if (TRACKING_QUERY_KEYS.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function wildcardRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function documentUrlAllowed(value, options = DEFAULT_CAPTURE_OPTIONS) {
  const includes = options.includeUrlPatterns || [];
  const excludes = options.excludeUrlPatterns || [];
  if (excludes.some((pattern) => wildcardRegex(pattern).test(value))) return false;
  return !includes.length || includes.some((pattern) => wildcardRegex(pattern).test(value));
}

export function resourceTypeKey(type) {
  return ({ Stylesheet: 'stylesheet', Script: 'script', Image: 'image', Media: 'media', Font: 'font', XHR: 'xhr', Fetch: 'xhr' })[type] || 'other';
}

export function resourceTypeAllowed(type, resourceTypes = DEFAULT_CAPTURE_OPTIONS.resourceTypes) {
  if (type === 'Document') return true;
  return resourceTypes[resourceTypeKey(type)] !== false;
}
