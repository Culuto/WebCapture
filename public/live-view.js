const POLL_MS = 500;
const STREAM_PAUSED_NOTE = 'パソコンの負荷が高いため、映像を一時停止している（保存は続いている）。';
const STORAGE_KEY = 'webcapture.liveView.enabled';
const SIZE_KEY = 'webcapture.liveView.size';
const SIZE_MIN_WIDTH = { small: 220, medium: 360, large: 520 };
const TILE_RATIO = 16 / 9;
const LIVE_STATUSES = new Set(['running', 'queued']);

function readEnabled() {
  try { return localStorage.getItem(STORAGE_KEY) !== 'off'; } catch { return true; }
}

function writeEnabled(enabled) {
  try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch {}
}

function shortLabel(slot) {
  if (!slot.url) return '待機中';
  try {
    const url = new URL(slot.url);
    return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`;
  } catch { return slot.url; }
}

function phaseTone(phase) {
  if (phase === 'failed') return 'failed';
  if (phase === 'done' || phase === 'shared') return 'done';
  if (['waiting', 'skipped'].includes(phase)) return 'stopped';
  if (phase === 'idle') return 'idle';
  return 'busy';
}

export function createLiveView({ root, uiLog, setIcon, isViewActive }) {
  const tabs = root.querySelector('#live-tabs');
  const panes = root.querySelector('#live-panes');
  const toggle = root.querySelector('#live-toggle');
  const note = root.querySelector('#live-note');
  const expand = root.querySelector('#live-expand');
  const sizeSelect = root.querySelector('#live-size');
  const tabsShell = root.querySelector('#live-tabs-shell');
  const tabsPrev = root.querySelector('#live-tabs-prev');
  const tabsNext = root.querySelector('#live-tabs-next');
  const syncTabArrows = () => {
    if (!tabsShell) return;
    const max = tabs.scrollWidth - tabs.clientWidth;
    const overflow = max > 2;
    tabsPrev.disabled = !overflow || tabs.scrollLeft <= 2;
    tabsNext.disabled = !overflow || tabs.scrollLeft >= max - 2;
    tabsShell.classList.toggle('fade-left', !tabsPrev.disabled);
    tabsShell.classList.toggle('fade-right', !tabsNext.disabled);
  };
  let revealedSelection = null;
  const revealActiveTab = () => {
    const active = tabs.querySelector('.live-tab.active');
    if (!active) return;
    const left = active.offsetLeft - tabs.offsetLeft;
    if (left < tabs.scrollLeft) tabs.scrollLeft = Math.max(0, left - 24);
    else if (left + active.offsetWidth > tabs.scrollLeft + tabs.clientWidth) tabs.scrollLeft = left + active.offsetWidth - tabs.clientWidth + 24;
  };
  tabs.addEventListener('scroll', syncTabArrows, { passive: true });
  tabs.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    const max = tabs.scrollWidth - tabs.clientWidth;
    if (max <= 2) return;
    const next = Math.max(0, Math.min(max, tabs.scrollLeft + event.deltaY));
    if (next === tabs.scrollLeft) return;
    event.preventDefault();
    tabs.scrollLeft = next;
  }, { passive: false });
  tabsPrev?.addEventListener('click', () => tabs.scrollBy({ left: -Math.max(160, tabs.clientWidth * 0.7), behavior: 'smooth' }));
  tabsNext?.addEventListener('click', () => tabs.scrollBy({ left: Math.max(160, tabs.clientWidth * 0.7), behavior: 'smooth' }));
  const state = { jobId: null, enabled: readEnabled(), selected: 'all', slots: [], timer: null, inFlight: false, shownSeq: new Map(), loading: new Set(), expanded: false, pollMs: POLL_MS, size: 'auto' };
  try { const saved = localStorage.getItem(SIZE_KEY); if (['auto', 'small', 'medium', 'large', 'max'].includes(saved)) state.size = saved; } catch {}
  root.dataset.size = state.size;
  sizeSelect.value = state.size;

  function frameUrl(index, seq) {
    return `/api/jobs/${encodeURIComponent(state.jobId)}/live/${index}/frame?seq=${seq}`;
  }

  function clearFrame(image) {
    if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
    delete image.dataset.objectUrl;
    image.removeAttribute('src');
    image.hidden = true;
  }

  async function showFrame(index, seq, image, placeholder, alt) {
    const jobId = state.jobId;
    state.loading.add(index);
    let objectUrl = null;
    try {
      const response = await fetch(frameUrl(index, seq), { cache: 'no-store' });
      if (response.status !== 200) return;
      objectUrl = URL.createObjectURL(await response.blob());
      const next = new Image();
      next.src = objectUrl;
      await next.decode();
      if (jobId !== state.jobId || !image.isConnected || state.shownSeq.get(index) !== seq) return;
      const previous = image.dataset.objectUrl;
      image.src = objectUrl;
      image.dataset.objectUrl = objectUrl;
      objectUrl = null;
      image.alt = alt;
      image.hidden = false;
      placeholder.hidden = true;
      if (previous) URL.revokeObjectURL(previous);
    } catch (error) {
      uiLog('live.frame.failed', { index, message: error.message }, 'warn');
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      state.loading.delete(index);
    }
  }

  function tabButton(key, label, iconName) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'live-tab';
    button.setAttribute('role', 'tab');
    button.dataset.liveTab = key;
    if (iconName) {
      const icon = document.createElement('span');
      icon.dataset.icon = iconName;
      icon.setAttribute('aria-hidden', 'true');
      button.append(icon);
      setIcon(button, iconName);
    }
    const text = document.createElement('span');
    text.className = 'live-tab-label';
    text.textContent = label;
    button.append(text);
    return button;
  }

  function paneElement(index) {
    const pane = document.createElement('article');
    pane.className = 'live-pane';
    pane.dataset.liveSlot = String(index);
    const bar = document.createElement('div');
    bar.className = 'live-bar';
    const dot = document.createElement('span');
    dot.className = 'live-dot';
    const number = document.createElement('strong');
    number.className = 'live-number';
    number.textContent = String(index + 1);
    const address = document.createElement('span');
    address.className = 'live-address';
    bar.append(dot, number, address);
    const screen = document.createElement('button');
    screen.type = 'button';
    screen.className = 'live-screen';
    screen.dataset.liveOpen = String(index);
    screen.setAttribute('aria-label', `${index + 1}番目のタブを大きく表示`);
    const image = document.createElement('img');
    image.alt = '';
    image.hidden = true;
    image.decoding = 'async';
    const placeholder = document.createElement('span');
    placeholder.className = 'live-placeholder';
    const phase = document.createElement('span');
    phase.className = 'live-phase';
    screen.append(image, placeholder, phase);
    pane.append(bar, screen);
    return pane;
  }

  function ensureStructure(count) {
    if (panes.children.length === count && tabs.children.length === count + 1) return;
    for (const image of panes.querySelectorAll('img')) clearFrame(image);
    state.shownSeq.clear();
    tabs.replaceChildren(tabButton('all', '一覧', 'layout-grid'), ...Array.from({ length: count }, (_, index) => tabButton(String(index), String(index + 1))));
    panes.replaceChildren(...Array.from({ length: count }, (_, index) => paneElement(index)));
    if (state.selected !== 'all' && Number(state.selected) >= count) state.selected = 'all';
  }

  function applySelection() {
    const single = state.selected !== 'all';
    panes.classList.toggle('single', single);
    panes.dataset.count = String(panes.children.length);
    panes.classList.toggle('many', panes.children.length > 10);
    for (const button of tabs.children) {
      const active = button.dataset.liveTab === state.selected;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    for (const pane of panes.children) pane.hidden = single && pane.dataset.liveSlot !== state.selected;
    fitGrid();
    if (revealedSelection !== state.selected) { revealedSelection = state.selected; revealActiveTab(); }
    requestAnimationFrame(syncTabArrows);
  }

  function fitGrid() {
    if (panes.hidden || root.hidden) { panes.style.removeProperty('grid-template-columns'); return; }
    const count = Math.max(1, [...panes.children].filter((pane) => !pane.hidden).length);
    const gap = state.expanded ? 10 : 12;
    const sample = [...panes.children].find((pane) => !pane.hidden);
    const sampleScreen = sample?.querySelector('.live-screen');
    const measuredChrome = sample && sampleScreen ? sample.getBoundingClientRect().height - sampleScreen.getBoundingClientRect().height : 0;
    const barHeight = Math.max(34, Math.ceil(measuredChrome) + 2);
    const width = panes.clientWidth;
    if (!width) return;
    const height = state.expanded ? panes.clientHeight : Math.max(320, window.innerHeight - 190);
    if (state.size !== 'auto' && panes.classList.contains('single') === false) {
      if (!state.expanded) { panes.style.removeProperty('grid-template-columns'); return; }
      const minimum = state.size === 'max' ? width : SIZE_MIN_WIDTH[state.size];
      const columns = Math.max(1, Math.min(count, Math.floor((width + gap) / (minimum + gap))));
      panes.style.gridTemplateColumns = `repeat(${columns}, ${Math.floor((width - gap * (columns - 1)) / columns)}px)`;
      return;
    }
    let best = { columns: 1, tile: 0 };
    for (let columns = 1; columns <= count; columns += 1) {
      const rows = Math.ceil(count / columns);
      const byWidth = (width - gap * (columns - 1)) / columns;
      const byHeight = ((height - gap * (rows - 1)) / rows - barHeight) * TILE_RATIO;
      const tile = Math.floor(Math.min(byWidth, byHeight));
      if (tile > best.tile) best = { columns, tile };
    }
    panes.style.gridTemplateColumns = `repeat(${best.columns}, ${Math.max(160, best.tile)}px)`;
  }

  function setExpanded(expanded, reason) {
    if (state.expanded === expanded) return;
    state.expanded = expanded;
    root.classList.toggle('expanded', expanded);
    document.body.classList.toggle('live-expanded', expanded);
    const label = expanded ? '拡大表示を閉じる' : 'ライブ表示を画面いっぱいに拡大';
    expand.setAttribute('aria-pressed', String(expanded));
    expand.setAttribute('aria-label', label);
    expand.dataset.tooltip = expanded ? '拡大を閉じる' : '拡大表示';
    setIcon(expand, expanded ? 'minimize' : 'maximize');
    uiLog('live.expanded', { expanded, reason, jobId: state.jobId });
    requestAnimationFrame(fitGrid);
  }

  function renderSlots() {
    ensureStructure(state.slots.length);
    state.slots.forEach((slot, index) => {
      const pane = panes.children[index];
      const tab = tabs.children[index + 1];
      const label = shortLabel(slot);
      tab.querySelector('.live-tab-label').textContent = `${index + 1} ${slot.title || label}`;
      tab.dataset.tone = phaseTone(slot.phase);
      pane.dataset.tone = phaseTone(slot.phase);
      pane.querySelector('.live-address').textContent = slot.url || '次のページを待っています';
      pane.querySelector('.live-phase').textContent = slot.phaseLabel || '';
      const image = pane.querySelector('img');
      const placeholder = pane.querySelector('.live-placeholder');
      const visible = !pane.hidden;
      if (!slot.hasFrame) {
        clearFrame(image);
        state.shownSeq.delete(index);
        placeholder.textContent = slot.url ? (['http', 'file'].includes(slot.phase) ? '画面を使わない方式で保存しています' : '画面を準備中') : '待機中';
        placeholder.hidden = false;
        return;
      }
      if (image.hidden) { placeholder.textContent = '画面を準備中'; placeholder.hidden = false; }
      if (visible && state.shownSeq.get(index) !== slot.frameSeq && !state.loading.has(index)) {
        state.shownSeq.set(index, slot.frameSeq);
        showFrame(index, slot.frameSeq, image, placeholder, `${slot.title || label} の保存中の画面`);
      }
    });
    applySelection();
  }

  async function poll() {
    state.timer = null;
    if (!state.jobId || !state.enabled || state.inFlight) return schedule();
    if (document.visibilityState !== 'visible' || !isViewActive()) return schedule();
    state.inFlight = true;
    const jobId = state.jobId;
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/live`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (jobId !== state.jobId) return;
      state.slots = Array.isArray(payload.slots) ? payload.slots : [];
      state.pollMs = Math.max(POLL_MS, Number(payload.pollMs) || POLL_MS);
      note.hidden = state.slots.length > 0 && !payload.streamPaused;
      note.textContent = payload.streamPaused ? STREAM_PAUSED_NOTE : payload.phase === 'discovering' ? 'サイトの構造を調べています。ページの保存が始まると、ここに画面が映ります。' : '保存の開始を待っています。';
      renderSlots();
    } catch (error) {
      uiLog('live.poll.failed', { message: error.message }, 'warn');
    } finally {
      state.inFlight = false;
      schedule();
    }
  }

  function schedule() {
    if (state.timer || !state.jobId || !state.enabled) return;
    state.timer = setTimeout(poll, state.pollMs || POLL_MS);
  }

  function stop() {
    clearTimeout(state.timer);
    state.timer = null;
  }

  function renderToggle() {
    toggle.setAttribute('aria-pressed', String(state.enabled));
    const label = state.enabled ? 'ライブ表示を隠す' : 'ライブ表示を出す';
    toggle.setAttribute('aria-label', label);
    toggle.dataset.tooltip = label;
    setIcon(toggle, state.enabled ? 'eye-off' : 'eye');
    root.classList.toggle('collapsed', !state.enabled);
    expand.hidden = !state.enabled;
    if (!state.enabled) setExpanded(false, 'hidden');
    tabs.hidden = !state.enabled;
    if (tabsShell) tabsShell.hidden = !state.enabled;
    panes.hidden = !state.enabled;
    if (!state.enabled) note.hidden = true;
  }

  toggle.addEventListener('click', () => {
    state.enabled = !state.enabled;
    writeEnabled(state.enabled);
    uiLog('live.toggle', { enabled: state.enabled, jobId: state.jobId });
    renderToggle();
    if (state.enabled) { stop(); poll(); } else stop();
  });

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-live-tab]');
    if (!button) return;
    state.selected = button.dataset.liveTab;
    uiLog('live.tab.selected', { tab: state.selected, jobId: state.jobId });
    state.shownSeq.clear();
    renderSlots();
  });

  panes.addEventListener('click', (event) => {
    const screen = event.target.closest('[data-live-open]');
    if (!screen) return;
    state.selected = state.selected === 'all' ? screen.dataset.liveOpen : 'all';
    uiLog('live.pane.opened', { tab: state.selected, jobId: state.jobId });
    state.shownSeq.clear();
    renderSlots();
  });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.jobId && state.enabled) { stop(); poll(); } });
  expand.addEventListener('click', () => setExpanded(!state.expanded, 'button'));
  sizeSelect.addEventListener('change', () => {
    state.size = sizeSelect.value;
    root.dataset.size = state.size;
    try { localStorage.setItem(SIZE_KEY, state.size); } catch {}
    uiLog('live.size.changed', { size: state.size });
    fitGrid();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && state.expanded) setExpanded(false, 'escape'); });
  window.addEventListener('resize', () => { fitGrid(); syncTabArrows(); });
  let observedWidth = 0;
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      syncTabArrows();
      if (panes.clientWidth === observedWidth) return;
      observedWidth = panes.clientWidth;
      fitGrid();
    }).observe(root);
  }

  renderToggle();

  return {
    setJob(job) {
      const live = job && LIVE_STATUSES.has(job.status) ? job : null;
      const wasHidden = root.hidden;
      root.hidden = !live;
      if (live && wasHidden) requestAnimationFrame(fitGrid);
      if (!live) {
        setExpanded(false, 'finished');
        if (state.jobId) { stop(); state.jobId = null; state.slots = []; ensureStructure(0); }
        return;
      }
      if (live.id !== state.jobId) {
        stop();
        state.jobId = live.id;
        state.selected = 'all';
        state.slots = [];
        ensureStructure(0);
        note.hidden = !state.enabled;
        note.textContent = '保存の開始を待っています。';
        if (state.enabled) poll();
      }
    }
  };
}
