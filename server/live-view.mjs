const VIEWER_TTL_MS = 5000;
const MIN_FRAME_INTERVAL_MS = 200;
const PHASE_LABELS = Object.freeze({
  waiting: '順番待ち',
  opening: 'ページを開いています',
  loading: '読み込み中',
  preparing: 'スクロールして要素を読み込み中',
  settling: '通信の完了待ち',
  serializing: 'ページ内容を記録中',
  screenshot: 'スクリーンショットを撮影中',
  interacting: 'ボタンやメニューを確認中',
  reading: '素材を記録中',
  recovering: '足りない素材を補完中',
  http: 'HTTPで取得中（画面なし）',
  file: 'ファイルとして保存中（画面なし）',
  done: '保存完了',
  skipped: '保存対象外',
  shared: '保存済みのページを共有',
  failed: '保存失敗'
});

export function livePhaseLabel(phase) {
  return PHASE_LABELS[phase] || '';
}

export class LiveViewHub {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.jobs = new Map();
    this.viewers = new Map();
    this.pressure = 'normal';
  }

  setPressure(pressure) {
    this.pressure = pressure || 'normal';
  }

  streamPaused() {
    return this.pressure === 'critical';
  }

  frameIntervalMs() {
    return this.pressure === 'high' ? 1000 : this.pressure === 'elevated' ? 500 : 200;
  }

  pollMs() {
    return this.pressure === 'critical' ? 3000 : this.pressure === 'high' ? 1500 : 500;
  }

  touchViewer(jobId) {
    this.viewers.set(jobId, this.now());
  }

  wanted(jobId) {
    const seenAt = this.viewers.get(jobId);
    return !this.streamPaused() && seenAt !== undefined && this.now() - seenAt < VIEWER_TTL_MS;
  }

  slotsOf(jobId) {
    if (!this.jobs.has(jobId)) this.jobs.set(jobId, new Map());
    return this.jobs.get(jobId);
  }

  slot(jobId, index) {
    const slots = this.slotsOf(jobId);
    if (!slots.has(index)) slots.set(index, { index, url: '', title: '', phase: 'waiting', frame: null, frameSeq: 0, frameAt: 0, updatedAt: this.now() });
    return slots.get(index);
  }

  begin(jobId, index, url) {
    const slot = this.slot(jobId, index);
    Object.assign(slot, { url, title: '', phase: 'waiting', frame: null, updatedAt: this.now() });
    slot.frameSeq += 1;
    return this.channel(jobId, index);
  }

  update(jobId, index, patch) {
    const slot = this.slot(jobId, index);
    for (const key of ['url', 'title', 'phase']) if (typeof patch[key] === 'string') slot[key] = patch[key].slice(0, 2000);
    slot.updatedAt = this.now();
  }

  frame(jobId, index, buffer) {
    const slot = this.slot(jobId, index);
    const now = this.now();
    if (now - slot.frameAt < MIN_FRAME_INTERVAL_MS) return false;
    Object.assign(slot, { frame: buffer, frameAt: now, updatedAt: now });
    slot.frameSeq += 1;
    return true;
  }

  channel(jobId, index) {
    return {
      wanted: () => this.wanted(jobId),
      frameIntervalMs: () => this.frameIntervalMs(),
      update: (patch) => this.update(jobId, index, patch),
      phase: (phase) => this.update(jobId, index, { phase }),
      frame: (buffer) => this.frame(jobId, index, buffer)
    };
  }

  snapshot(jobId, slotCount = 0) {
    const slots = this.jobs.get(jobId) || new Map();
    const count = Math.max(slotCount, ...[...slots.keys()].map((index) => index + 1), 0);
    return Array.from({ length: count }, (_, index) => {
      const slot = slots.get(index);
      if (!slot) return { index, url: '', title: '', phase: 'idle', phaseLabel: '待機中', frameSeq: 0, hasFrame: false };
      return {
        index, url: slot.url, title: slot.title, phase: slot.phase, phaseLabel: livePhaseLabel(slot.phase),
        frameSeq: slot.frameSeq, hasFrame: Boolean(slot.frame)
      };
    });
  }

  frameOf(jobId, index) {
    return this.jobs.get(jobId)?.get(index)?.frame || null;
  }

  clearJob(jobId) {
    this.jobs.delete(jobId);
    this.viewers.delete(jobId);
  }
}
