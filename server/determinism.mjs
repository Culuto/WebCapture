// 保存時と再生時でページ内の乱数を同じ系列にするための種。ページURLから作ります。
export function pageSeed(url) {
  let hash = 0x811c9dc5;
  for (const character of String(url || '')) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ページ内で実行する関数。Math.randomを種から決まる系列に置き換えます。
export function installSeededRandom(seed) {
  if (window.__webcaptureSeededRandom) return;
  let state = seed >>> 0 || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  Object.defineProperty(window, '__webcaptureSeededRandom', { value: true, configurable: true });
  Math.random = next;
}

// ページ内で実行する関数。時計を保存時刻から進めます。
export function installArchivedClock(capturedAt) {
  if (!Number.isFinite(capturedAt) || window.__webcaptureArchivedClock) return;
  const RealDate = Date;
  const offset = capturedAt - RealDate.now();
  function ArchivedDate(...args) {
    if (!new.target) return new RealDate(RealDate.now() + offset).toString();
    return args.length ? new RealDate(...args) : new RealDate(RealDate.now() + offset);
  }
  ArchivedDate.prototype = RealDate.prototype;
  ArchivedDate.now = () => RealDate.now() + offset;
  ArchivedDate.parse = RealDate.parse;
  ArchivedDate.UTC = RealDate.UTC;
  Object.setPrototypeOf(ArchivedDate, RealDate);
  Object.defineProperty(window, '__webcaptureArchivedClock', { value: capturedAt, configurable: true });
  window.Date = ArchivedDate;
}
