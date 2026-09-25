import { archiveReplayOrigin } from './replay-origin.js';
import { replayState, applyReplayMessage, replayStateLabel, isReplayMessageCurrent, appendReplayHistory } from './replay-state.js';
import { hydrateIcons, setIcon } from './icon-system.js';
import { createLiveView } from './live-view.js';
import { readUiPrefs, writeUiPrefs, resolveTheme, urlPatternList } from './ui-prefs.js';
import { applyLanguage } from './i18n.js';

const state = {
  csrfToken: '', config: null, browser: null, jobs: [], archives: [], activeJobId: null,
  replayLight: false, heavyArchives: new Set(), staticReplayPages: new Set(), replayBeatAt: null, replayNavigatedAt: null,
  selectedArchive: null, manifest: null, runtimeMisses: null, replayStatus: null, replayHistory: [], replayIndex: -1, pollTimer: null,
  archiveFilter: '', archivePageSize: 60, archiveTotal: 0, archiveHasMore: false,
  archiveRevision: 0, stateRevision: 0, archiveOpenToken: 0, archiveOpeningId: null,
  archiveRequestToken: 0, archiveRenderSignature: '', refreshInFlight: null, deletingArchiveIds: new Set(), replayNavigationId: 0,
  metrics: null, load: null, replayAudit: null, replayAuditRequestToken: 0
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const safeStorage = () => { try { return window.localStorage; } catch { return null; } };
const uiPrefs = readUiPrefs(safeStorage());
const liveView = createLiveView({ root: $('#live-view'), uiLog, setIcon, isViewActive: () => $('#save-view').classList.contains('active') });
const diagnosticQueue = [];
let lastVisibleButtons = '';
let captureDefaultsApplied = false;
let actionModalResolve = null;
let actionModalTrigger = null;
let helpTrigger = null;
let helpOpen = false;
let replayDetailsTimer = null;
let replayDetailsInFlight = false;
let replayDetailsPending = false;
let csrfRefreshPromise = null;
let lowImpactPending = false;

function buttonKey(button) {
  return button.id || button.dataset.viewTarget || button.dataset.action || button.getAttribute('aria-label') || [...button.classList].join('.') || 'button';
}

function uiLog(event, data = {}, level = 'info') {
  diagnosticQueue.push({ event, level, data: { ...data, view: $('.view.active')?.id || 'unknown' } });
  if (diagnosticQueue.length > 1000) diagnosticQueue.splice(0, diagnosticQueue.length - 1000);
}

async function flushDiagnostics() {
  if (!state.csrfToken || !diagnosticQueue.length) return;
  const events = diagnosticQueue.splice(0, 200);
  try {
    await api('/api/diagnostics/events', { method: 'POST', body: JSON.stringify({ events }) });
  } catch { diagnosticQueue.unshift(...events); }
}

function logVisibleButtons() {
  const buttons = $$('button').filter((button) => !button.hidden && button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden')
    .map((button) => ({ key: buttonKey(button), enabled: !button.disabled }));
  const signature = JSON.stringify(buttons);
  if (signature !== lastVisibleButtons) { lastVisibleButtons = signature; uiLog('buttons.visible', { buttons }); }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let result = bytes;
  let unit = -1;
  do { result /= 1024; unit += 1; } while (result >= 1024 && unit < units.length - 1);
  return `${result.toFixed(result >= 100 ? 0 : result >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ja-JP', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
}

function formatPercent(part, key = 'percent') {
  return part?.available && Number.isFinite(Number(part[key])) ? `${Number(part[key]).toFixed(1)}%` : '—';
}

function formatRate(part) {
  return part?.available && Number.isFinite(Number(part.bytesPerSecond)) ? `${formatBytes(part.bytesPerSecond)}/秒` : '—';
}

function renderSystemMetrics() {
  const metrics = state.metrics;
  $('#metric-cpu').textContent = metrics ? formatPercent(metrics.cpu) : '計測中';
  $('#metric-memory').textContent = metrics ? formatPercent(metrics.memory) : '計測中';
  $('#metric-disk').textContent = metrics ? formatPercent(metrics.disk, 'busyPercent') : '計測中';
  $('#metric-network').textContent = metrics ? formatRate(metrics.network) : '計測中';
  $('#metric-gpu').textContent = metrics ? formatPercent(metrics.gpu) : '計測中';
  const capture = state.load?.capture;
  const waiting = Number(capture?.waiting || 0);
  $('#metric-capture-load').textContent = capture ? `${capture.active} / ${capture.limit}${waiting ? `（待ち${waiting}）` : ''}` : '0 / 10';
  const pressure = ({ normal: 'ON・通常の速さ', elevated: 'ON・少し減速中', high: 'ON・減速中', critical: 'ON・大きく減速中', off: 'OFF・減速しない' })[state.load?.pressure] || '計測中';
  $('#metric-low-impact').textContent = pressure;
  if (typeof state.load?.lowImpact === 'boolean' && !lowImpactPending) syncLowImpactSwitch(state.load.lowImpact);
  const status = $('#metrics-recording-status');
  if (status && metrics?.timestamp) status.textContent = `CPU・メモリ・ディスク・通信・GPUを5秒ごとに数値だけ記録します。最新記録: ${formatDate(metrics.timestamp)}。記録は7日後に自動削除します。`;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.hidden = true; }, 4200);
}

async function refreshCsrfToken(failedToken) {
  if (state.csrfToken && state.csrfToken !== failedToken) return state.csrfToken;
  if (!csrfRefreshPromise) {
    csrfRefreshPromise = (async () => {
      const response = await fetch('/api/session', { headers: { accept: 'application/json' }, cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.csrfToken) throw new Error('操作情報を更新できませんでした。画面を再読み込みしてください。');
      state.csrfToken = payload.csrfToken;
      uiLog('session.refreshed');
      return state.csrfToken;
    })().finally(() => { csrfRefreshPromise = null; });
  }
  return csrfRefreshPromise;
}

async function api(path, options = {}, allowCsrfRetry = true) {
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  const method = String(options.method || 'GET').toUpperCase();
  const mutation = !['GET', 'HEAD'].includes(method);
  const sentToken = state.csrfToken;
  if (mutation) {
    headers['content-type'] = 'application/json';
    headers['x-webcapture-csrf'] = sentToken;
  }
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (cause) {
    const offline = new Error('WebCaptureのサーバーに接続できません。アプリが起動しているか確認してください。');
    offline.code = 'SERVER_UNREACHABLE';
    offline.cause = cause;
    throw offline;
  }
  const payload = await response.json().catch(() => ({ ok: false, error: { message: '応答を読み取れませんでした。' } }));
  if (mutation && allowCsrfRetry && response.status === 403 && payload.error?.code === 'CSRF_REJECTED') {
    await refreshCsrfToken(sentToken);
    return api(path, options, false);
  }
  if (!response.ok || payload.ok === false) throw new Error(payload.error?.message || '処理に失敗しました。');
  return payload;
}

function showView(name, { focus = true } = {}) {
  const targetId = `${name}-view`;
  $$('.view').forEach((view) => {
    const active = view.id === targetId;
    view.classList.toggle('active', active);
    view.setAttribute('aria-hidden', String(!active));
  });
  const activeTab = $$('.tab').find((tab) => tab.dataset.viewTarget === name);
  $$('.tab').forEach((tab) => {
    const active = tab === activeTab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  if (focus) requestAnimationFrame(() => (activeTab || $(`#${targetId}`))?.focus());
  uiLog('view.shown', { name, focus });
  requestAnimationFrame(logVisibleButtons);
}

function statusLabel(status) {
  return ({
    queued: '開始待ち', running: '保存中', discovering: '構造把握中', paused: '一時停止', warning: '確認待ち', complete: '完了',
    'complete-with-errors': '一部エラー', cancelled: '中止', 'limit-reached': '上限停止',
    failed: '保存失敗', blocked: 'アクセス確認で停止', 'login-required': 'ログインが必要', discovered: '把握済み（確認待ち）'
  })[status] || status;
}

function qualityLabel(quality) {
  if (!quality) return '未判定';
  const label = ({ verified: '良好', good: 'おおむね良好', partial: '欠落あり', blocked: 'アクセス不可', failed: '保存失敗' })[quality.level] || quality.level;
  return Number.isFinite(Number(quality.score)) ? `${label}（${quality.score}点）` : label;
}

function activeJob() {
  const selected = state.jobs.find((job) => job.id === state.activeJobId);
  if (selected && ['running', 'queued', 'warning'].includes(selected.status)) return selected;
  const priority = { running: 0, queued: 1, warning: 2 };
  return state.jobs.filter((job) => job.status in priority).sort((a, b) =>
    priority[a.status] - priority[b.status] || new Date(b.updatedAt) - new Date(a.updatedAt)
  )[0];
}

function pausedJobLabel(job) {
  try { const url = new URL(job.startUrl); return `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`; } catch { return job.startUrl || '保存処理'; }
}

function renderPausedJobs() {
  const paused = state.jobs.filter((job) => job.status === 'paused')
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  $('#paused-jobs-region').hidden = !paused.length;
  $('#paused-jobs-count').textContent = paused.length ? `${paused.length}件` : '';
  const list = $('#paused-jobs');
  const signature = paused.map((job) => `${job.id}:${job.pages}:${job.updatedAt}`).join('|');
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  const visible = paused.slice(0, 6);
  list.replaceChildren(...visible.map((job) => {
    const item = document.createElement('li');
    const text = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = pausedJobLabel(job);
    const detail = document.createElement('span'); detail.textContent = `${job.pages}ページ保存済み・${job.message || '中断中'}`;
    text.append(title, detail);
    const actions = document.createElement('div'); actions.className = 'actions';
    for (const [action, icon, label, extra] of [['resume', 'play', '再開', ''], ['cancel', 'square', '停止して保存済み分を残す', ' danger']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `secondary icon-only${extra}`;
      button.dataset.jobAction = action; button.dataset.jobId = job.id;
      button.setAttribute('aria-label', `${pausedJobLabel(job)}を${label}`); button.dataset.tooltip = label;
      const holder = document.createElement('span'); holder.dataset.icon = icon; holder.setAttribute('aria-hidden', 'true');
      button.append(holder); setIcon(button, icon);
      actions.append(button);
    }
    item.append(text, actions);
    return item;
  }));
  const more = paused.length - visible.length;
  let note = $('#paused-jobs-region .paused-more');
  if (more > 0) {
    if (!note) { note = document.createElement('p'); note.className = 'paused-more'; $('#paused-jobs-region .paused-details').append(note); }
    note.textContent = `ほか${more}件`;
  } else note?.remove();
}

function renderProgress() {
  const job = activeJob();
  $('#progress-region').hidden = !job;
  liveView.setJob(job);
  renderTuningStatus(job);
  if (state.lastProgressJobId && !job) { loadAppSettings(); toast('保存が終わりました。結果はアーカイブ一覧で確認できます。'); uiLog('job.finished.noticed', { jobId: state.lastProgressJobId }); }
  state.lastProgressJobId = job?.id || null;
  renderPausedJobs();
  renderDiscovered();
  if (!job) {
    $('#job-actions').hidden = true;
    $('#progress-percent').textContent = '0%';
    $('#meter-fill').style.width = '0%';
    $('#progress-depth').textContent = '—';
    $('#progress-pages-label').textContent = 'ページ';
    $('#progress-pages').textContent = '0';
    $('#progress-resources').textContent = '0';
    $('#progress-errors').textContent = '0';
    $('#progress-errors').classList.remove('has-errors');
    $('#current-url').textContent = '保存処理はありません。';
    $('#crawl-tree').className = 'crawl-tree empty';
    $('#crawl-tree').setAttribute('aria-busy', 'false');
    $('#crawl-tree').textContent = 'URLを入力して保存を開始すると、ここに巡回経路が表示されます。';
    $('#progress-meter').setAttribute('aria-valuenow', '0');
    $('#progress-meter').setAttribute('aria-valuetext', '保存処理はありません');
    return;
  }
  state.activeJobId = job.id;
  const queueCount = Number(job.queueCount ?? job.queue?.length ?? 0);
  const inFlightCount = Number(job.inFlightCount ?? job.inFlight?.length ?? 0);
  const percent = Math.min(99, Math.round((job.pages / Math.max(job.pages + queueCount + inFlightCount, 1)) * 100));
  const complete = ['complete', 'complete-with-errors'].includes(job.status);
  const shownPercent = complete ? 100 : percent;
  const captureTotal = job.discoveredPages || (job.pages + queueCount + inFlightCount) || job.options?.maxPages || null;
  $('#progress-percent').textContent = `${shownPercent}%`;
  $('#meter-fill').style.width = `${shownPercent}%`;
  $('#progress-meter').setAttribute('aria-valuenow', String(shownPercent));
  $('#progress-meter').setAttribute('aria-valuetext', `${shownPercent}%、${statusLabel(job.status)}`);
  $('#progress-depth').textContent = `L${Math.max(0, ...(job.inFlight || []).map((item) => Number(item.externalDepth) || 0))}`;
  $('#progress-pages-label').textContent = job.phase === 'discovering' ? '構造把握 / 保存' : 'ページ';
  $('#progress-pages').textContent = job.phase === 'discovering'
    ? `${job.discoveredPages || 0}ページ把握 / ${job.pages}ページ保存`
    : captureTotal ? `${job.pages} / ${captureTotal}` : `${job.pages}`;
  $('#progress-resources').textContent = String(job.resources);
  $('#progress-errors').textContent = String(job.errors);
  $('#progress-errors').classList.toggle('has-errors', Number(job.errors) > 0);
  $('#stalled-note').hidden = !Number(job.stalledPages);
  $('#stalled-note').textContent = Number(job.stalledPages) ? `止まったページを${job.stalledPages}件打ち切り、取り直しに回しました。` : '';
  $('#current-url').textContent = job.currentUrl ? `${job.message || statusLabel(job.status)}: ${job.currentUrl}` : (job.message || statusLabel(job.status));
  const actionable = ['running', 'queued', 'paused'].includes(job.status);
  $('#job-actions').hidden = !actionable;
  $('#pause-job').setAttribute('aria-label', job.status === 'paused' ? '再開' : '一時停止');
  $('#pause-job').dataset.tooltip = job.status === 'paused' ? '再開' : '一時停止';
  setIcon($('#pause-job'), job.status === 'paused' ? 'play' : 'pause');
  $('#pause-job').disabled = !['running', 'paused'].includes(job.status);
  $('#cancel-job').disabled = !['running', 'queued', 'paused'].includes(job.status);
  $('#crawl-tree').setAttribute('aria-busy', String(['running', 'queued', 'discovering'].includes(job.status)));
  renderTree(job);
  if (job.warning) showWarning(job);
}

function renderTree(job) {
  const tree = $('#crawl-tree');
  const previousScroll = tree.scrollTop;
  tree.className = 'crawl-tree';
  tree.replaceChildren();
  const activeUrls = new Set([...(job.inFlight || []).map((item) => item.url), job.currentUrl].filter(Boolean));
  const visited = Array.isArray(job.visited) ? job.visited : [];
  const queue = Array.isArray(job.queue) ? job.queue : [];
  const rows = [
    ...(job.visitedDetails?.length
      ? job.visitedDetails.slice(-80).map((item) => ({ ...item, state: '保存済み' }))
      : visited.slice(-80).map((url) => ({ url, depth: 0, state: '保存済み' }))),
    ...(job.currentUrl && !activeUrls.has(job.currentUrl) ? [{ url: job.currentUrl, depth: job.depth, state: statusLabel(job.status) }] : []),
    ...(job.inFlight || []).map((item) => ({ url: item.url, depth: item.depth, scope: item.scope, externalDepth: item.externalDepth, state: '保存中' })),
    ...(job.plannedQueue || []).filter((item) => !activeUrls.has(item.url)).slice(-80).map((item) => ({ url: item.url, depth: item.depth, scope: item.scope, externalDepth: item.externalDepth, state: '把握済み' })),
    ...queue.filter((item) => !activeUrls.has(item.url)).slice(0, 80).map((item) => ({ url: item.url, depth: item.depth, scope: item.scope, externalDepth: item.externalDepth, state: '待機中' }))
  ];
  if (!rows.length) {
    tree.className = 'crawl-tree empty';
    tree.textContent = '巡回待ち。';
    return;
  }
  let startHost = '';
  try { startHost = new URL(job.startUrl).hostname; } catch {}
  const sameSiteKeywords = job.options.sameSiteKeywords || [];
  for (const row of rows) {
    const element = document.createElement('div');
    element.className = 'tree-row'; element.setAttribute('role', 'listitem');
    const depth = document.createElement('span'); depth.className = 'depth'; depth.textContent = `L${Math.max(0, Number(row.externalDepth) || 0)}`;
    const url = document.createElement('span'); url.className = 'tree-url'; url.textContent = row.url;
    const scope = document.createElement('span'); scope.className = 'scope';
    try {
      const rowHost = new URL(row.url).hostname;
      const keywordMatch = sameSiteKeywords.some((keyword) => startHost.includes(keyword) && rowHost.includes(keyword));
      scope.textContent = row.scope === 'keyword-site' || keywordMatch
        ? '登録語一致'
        : rowHost === startHost || row.externalDepth === 0 ? '同一サイト' : 'リンク先';
    } catch { scope.textContent = '—'; }
    const status = document.createElement('span'); status.className = 'tree-state'; status.textContent = row.state;
    element.append(depth, url, scope, status);
    tree.append(element);
  }
  tree.scrollTop = previousScroll;
}

function archiveTitle(archive) {
  if (archive?.title) return archive.title;
  try { return new URL(archive?.startUrl || '').hostname || archive?.startUrl || '無題のアーカイブ'; } catch { return archive?.startUrl || '無題のアーカイブ'; }
}

function archiveRenderSignature() {
  const items = state.archives.map((archive) => [archive.id, archive.status, archive.pages, archive.resources, archive.bytes, archive.savedAt, archive.title, archive.startUrl, archive.quality?.level, archive.quality?.score].join('|')).join(';;');
  return `${state.archiveFilter}\u0000${state.archiveTotal}\u0000${state.archiveHasMore}\u0000${state.selectedArchive?.id || ''}\u0000${state.archiveOpeningId || ''}\u0000${items}`;
}

function renderArchives({ force = false } = {}) {
  const signature = archiveRenderSignature();
  if (!force && signature === state.archiveRenderSignature) return;
  state.archiveRenderSignature = signature;
  const tbody = $('#archive-table');
  const picker = $('#archive-picker-list');
  const previousPickerScroll = picker.scrollTop;
  const previousTableScroll = tbody.parentElement?.scrollTop || 0;
  const query = state.archiveFilter.trim();
  const visible = [...state.archives];
  const selected = state.selectedArchive;
  if (selected && !query && !visible.some((archive) => archive.id === selected.id)) visible.push(selected);
  const countText = query ? `${visible.length} / ${state.archiveTotal}件（絞り込み）` : `${visible.length} / ${state.archiveTotal}件`;
  $('#archive-table-count').textContent = countText;
  $('#archive-picker-count').textContent = countText;
  $('#archive-empty').hidden = visible.length > 0;
  $('#archive-empty').textContent = query ? '条件に一致する保存済みサイトはありません。' : '保存済みサイトはまだありません。';
  tbody.replaceChildren();
  picker.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('p'); empty.className = 'empty-row'; empty.textContent = query ? '条件に一致するアーカイブはありません。' : '保存済みサイトはまだありません。'; picker.append(empty);
  }
  const tableFragment = document.createDocumentFragment();
  const pickerFragment = document.createDocumentFragment();
  for (const archive of visible) {
    const row = document.createElement('tr'); row.dataset.archiveId = archive.id;
    const fields = [archive.startUrl, statusLabel(archive.status), String(archive.pages), formatBytes(archive.bytes), formatDate(archive.savedAt)];
    fields.forEach((value, index) => {
      const cell = document.createElement('td');
      if (index === 1) { const chip = document.createElement('span'); chip.className = 'status-chip'; chip.dataset.status = archive.status || ''; chip.textContent = value; cell.append(chip); if (archive.loggedIn) { const badge = document.createElement('span'); badge.className = 'login-badge'; badge.textContent = 'ログイン'; cell.append(badge); } }
      else cell.textContent = value;
      row.append(cell);
    });
    const actionCell = document.createElement('td'); actionCell.className = 'table-actions';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary icon-only'; button.innerHTML = '<span data-icon="archive" aria-hidden="true"></span>'; button.setAttribute('aria-label', 'アーカイブを開く'); button.dataset.tooltip = '開く'; button.dataset.archiveId = archive.id; setIcon(button, 'archive');
    button.addEventListener('click', () => openArchive(archive.id));
    const deleteButton = document.createElement('button'); deleteButton.type = 'button'; deleteButton.className = 'secondary danger icon-only'; deleteButton.innerHTML = '<span data-icon="trash" aria-hidden="true"></span>'; deleteButton.setAttribute('aria-label', 'アーカイブを削除'); deleteButton.dataset.tooltip = '削除'; deleteButton.dataset.archiveId = archive.id; setIcon(deleteButton, 'trash');
    deleteButton.disabled = state.deletingArchiveIds.has(archive.id);
    deleteButton.addEventListener('click', () => deleteArchive(archive.id));
    actionCell.append(button, deleteButton); row.append(actionCell); tableFragment.append(row);

    const pickerButton = document.createElement('button'); pickerButton.type = 'button'; pickerButton.className = 'archive-picker-item'; pickerButton.dataset.archiveId = archive.id;
    if (state.selectedArchive?.id === archive.id) { pickerButton.classList.add('active'); pickerButton.setAttribute('aria-current', 'page'); }
    if (state.archiveOpeningId === archive.id) { pickerButton.setAttribute('aria-busy', 'true'); pickerButton.disabled = true; }
    const title = document.createElement('strong'); title.textContent = archiveTitle(archive);
    const detail = document.createElement('span'); detail.textContent = `${statusLabel(archive.status)}・${archive.pages}ページ・${qualityLabel(archive.quality)}・${formatDate(archive.savedAt)}`;
    pickerButton.append(title, detail); pickerButton.addEventListener('click', () => openArchive(archive.id)); pickerFragment.append(pickerButton);
  }
  tbody.append(tableFragment); picker.append(pickerFragment);
  const loadMore = $('#archive-load-more');
  loadMore.hidden = !state.archiveHasMore;
  loadMore.textContent = state.archiveHasMore ? `さらに表示（残り${Math.max(0, state.archiveTotal - state.archives.length)}件）` : 'さらに表示';
  requestAnimationFrame(() => { picker.scrollTop = previousPickerScroll; if (tbody.parentElement) tbody.parentElement.scrollTop = previousTableScroll; });
}

function showWarning(job) {
  const warning = job.warning;
  const external = warning.scope === 'external';
  $('#warning-copy').textContent = external
    ? `外部サイトを${warning.depth}階層まで辿りました。続けると保存範囲と容量が大きくなる可能性があります。`
    : `同じ親サイト内を${warning.depth}階層まで辿りました。続けると保存範囲と容量が大きくなる可能性があります。`;
  $('#warning-url').textContent = warning.url;
  $('#warning-modal').dataset.jobId = job.id;
  $('#warning-modal').hidden = false;
  $('#warning-stop').focus();
}

async function resolveWarning(action) {
  const modal = $('#warning-modal');
  const jobId = modal.dataset.jobId;
  if (!jobId) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}/warning`, { method: 'POST', body: JSON.stringify({ action, suppress: $('#warning-suppress').checked }) });
    modal.hidden = true;
    $('#warning-suppress').checked = false;
    await refresh();
  } catch (error) { toast(error.message); }
}

function replayOriginFor(archiveId = state.selectedArchive?.id) {
  return archiveReplayOrigin(archiveId, state.config?.replayPort || new URL(state.config.replayOrigin).port, state.config.replayOrigin);
}

function pageReplayUrl(archiveId, url, navigationId) {
  return `${replayOriginFor(archiveId)}/archive/${encodeURIComponent(archiveId)}/page?url=${encodeURIComponent(url)}&navigationId=${encodeURIComponent(navigationId)}${state.replayLight ? '&mode=light' : state.staticReplayPages.has(`${archiveId} ${url}`) ? '&mode=static' : ''}`;
}

function navigateReplay(url, push = true) {
  if (!state.selectedArchive || !url) return;
  if (push) {
    const next = appendReplayHistory(state.replayHistory, state.replayIndex, url);
    state.replayHistory = next.history;
    state.replayIndex = next.index;
  }
  $('#replay-address').textContent = url;
  let canonicalUrl = url;
  let fragment = '';
  try { const parsed = new URL(url, state.manifest.startUrl); fragment = parsed.hash; parsed.hash = ''; canonicalUrl = parsed.href; } catch {}
  const page = state.manifest?.pages?.find(page => page.url === canonicalUrl || page.requestedUrl === canonicalUrl);
  const navigationId = String(++state.replayNavigationId);
  state.replayStatus = replayState(state.selectedArchive.id, page?.url || canonicalUrl, Boolean(page?.html), navigationId);
  renderReplayStatus();
  $('#replay-frame').setAttribute('aria-busy', 'true');
  signalReplayWarmup('webcapture-warm-pause');
  state.replayNavigatedAt = Date.now();
  state.replayBeatAt = null;
  $('#replay-frame').src = pageReplayUrl(state.selectedArchive.id, canonicalUrl, navigationId) + fragment;
  $('#replay-back').disabled = state.replayIndex <= 0;
  $('#replay-forward').disabled = state.replayIndex >= state.replayHistory.length - 1;
  highlightReplayPage(page?.url || canonicalUrl);
  uiLog('replay.navigated', { archiveId: state.selectedArchive.id, url, navigationId, historyLength: state.replayHistory.length });
}

function highlightReplayPage(pageUrl) {
  $$('.page-item').forEach((item) => {
    const active = item.dataset.url === pageUrl;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
}

function showReplayRedirect(status) {
  $('#replay-address').textContent = status.pageUrl;
  highlightReplayPage(status.pageUrl);
  uiLog('replay.redirected.saved', { archiveId: status.archiveId, navigationId: status.navigationId });
}

function renderReplayStatus() {
  $('#replay-status').textContent = replayStateLabel(state.replayStatus);
}

function scheduleReplayDetails() {
  replayDetailsPending = true;
  if (replayDetailsTimer || replayDetailsInFlight || !state.selectedArchive) return;
  replayDetailsTimer = setTimeout(async () => {
    replayDetailsTimer = null;
    replayDetailsInFlight = true;
    replayDetailsPending = false;
    const id = state.selectedArchive?.id;
    const token = state.archiveOpenToken;
    try {
      if (!id) return;
      const payload = await api(`/api/archives/${encodeURIComponent(id)}?view=diagnostics`);
      if (token !== state.archiveOpenToken || state.selectedArchive?.id !== id) return;
      state.selectedArchive = payload.archive;
      state.runtimeMisses = payload.runtimeMisses;
      state.manifest.quality = payload.archive.quality;
      state.archives = state.archives.map(archive => archive.id === id ? payload.archive : archive);
      renderArchiveMetadata();
      renderArchives();
      uiLog('replay.diagnostics.updated', { archiveId: id, missing: state.runtimeMisses?.unique || 0, total: state.runtimeMisses?.total || 0 });
    } catch (error) { uiLog('replay.diagnostics.failed', { archiveId: id, message: error.message }, 'warn'); }
    finally {
      replayDetailsInFlight = false;
      if (replayDetailsPending) scheduleReplayDetails();
    }
  }, 800);
}

function allowedReplayOrigins() {
  const ids = new Set([state.selectedArchive?.id, ...(state.manifest?.sharedPages || []).map((item) => item.archiveId)].filter(Boolean));
  return [...ids].map((archiveId) => replayOriginFor(archiveId));
}

function renderPageList() {
  const list = $('#page-list');
  list.replaceChildren();
  const filter = $('#page-filter').value.trim().toLowerCase();
  const pages = [...(state.manifest?.pages || []), ...(state.manifest?.sharedPages || []).map((item) => ({ url: item.url, title: `${item.url}（共有）`, depth: item.depth || 1, shared: true }))].filter((page) => `${page.title} ${page.url}`.toLowerCase().includes(filter));
  list.setAttribute('aria-busy', 'false');
  if (!pages.length) { const empty = document.createElement('p'); empty.className = 'empty-row'; empty.textContent = '該当するページはありません。'; list.append(empty); return; }
  for (const page of pages) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'page-item'; button.dataset.url = page.url;
    button.style.paddingInlineStart = `${12 + Math.min(page.depth, 6) * 10}px`;
    const icon = document.createElement('span'); icon.dataset.icon = 'file-text'; icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span'); label.className = 'page-item-label'; label.textContent = page.title || page.url;
    button.append(icon, label); setIcon(icon, 'file-text');
    if (state.replayStatus?.archiveId === state.selectedArchive?.id && state.replayStatus.pageUrl === page.url) { button.classList.add('active'); button.setAttribute('aria-current', 'page'); }
    button.addEventListener('click', () => navigateReplay(page.url)); list.append(button);
  }
}

function renderArchiveDetail() {
  const archive = state.selectedArchive;
  const manifest = state.manifest;
  if (!archive || !manifest) return;
  $('#replay-title').textContent = `${archiveTitle(archive)} — ${new Intl.DateTimeFormat('ja-JP').format(new Date(archive.savedAt))}`;
  const pageCount = manifest.pages?.length || 0;
  $('#replay-status').textContent = pageCount ? `${pageCount}ページを再生可能・${qualityLabel(archive.quality)}` : `${statusLabel(archive.status)}・再生できるページはありません`;
  renderArchiveMetadata();
  renderReplayAudit();
  renderDeferredMedia();
  renderPageList();
  const path = $('#crawl-path'); path.replaceChildren();
  for (const [index, page] of manifest.pages.slice(0, 12).entries()) {
    const node = document.createElement('div'); node.className = 'path-node';
    if (index && new URL(page.url).hostname !== new URL(manifest.pages[index - 1].url).hostname) node.classList.add('external');
    node.textContent = `${index + 1}. ${new URL(page.url).hostname}`; path.append(node);
  }
  ['replay-reload', 'replay-home', 'replay-light'].forEach((id) => { $(`#${id}`).disabled = !pageCount; });
  $('#replay-light').setAttribute('aria-pressed', String(Boolean(state.replayLight)));
  $('#delete-archive').disabled = Boolean(archive.repairRecovery) || replayAuditActive();
  applyReplayViewport();
  renderArchives();
  loadArchiveExtras(archive).catch((error) => uiLog('archive.extras.failed', { archiveId: archive.id, message: error.message }, 'warn'));
}

async function loadArchiveExtras(archive) {
  const id = archive.id;
  $('#storage-list').replaceChildren();
  $('#storage-total').textContent = '開くと計算します。';
  delete $('#storage-card').dataset.loadedFor;
  $('#diff-card').hidden = true;
  const plan = await api(`/api/archives/${encodeURIComponent(id)}/retry-plan`).then((payload) => payload.plan).catch(() => null);
  if (state.selectedArchive?.id !== id) return;
  state.retryPlan = plan;
  renderArchiveActions();
  if (archive.previousArchiveId) {
    const diff = await api(`/api/archives/${encodeURIComponent(id)}/diff`).then((payload) => payload.diff).catch(() => null);
    if (state.selectedArchive?.id === id) renderDiff(diff);
  }
  if ($('#storage-card').open) loadStorage();
}

function renderArchiveActions() {
  const plan = state.retryPlan;
  const busy = Boolean(plan?.busy);
  const remaining = Number(plan?.remainingCount || 0);
  $('#continue-archive').hidden = !remaining || busy;
  $('#continue-archive-label').textContent = `続きから保存（残り${remaining}件）`;
  const retryable = Number(plan?.failedPageCount || 0) + Number(plan?.missingResourceCount || 0) + (plan?.loginSites?.length || 0);
  $('#retry-archive').disabled = busy || !retryable;
  $('#resave-archive').disabled = busy;
  $('#export-archive').disabled = busy;
  const parts = [];
  if (busy) parts.push('保存中または一時停止中のため、終わってから操作できます。');
  else {
    if (remaining) parts.push(`まだ保存していないページが${remaining}件あります。`);
    if (plan?.failedPageCount) parts.push(`保存できなかったページ${plan.failedPageCount}件`);
    if (plan?.missingResourceCount) parts.push(`取れなかった素材${plan.missingResourceCount}件`);
    if (plan?.loginSites?.length) parts.push(`ログインが必要だったサイト${plan.loginSites.length}件`);
  }
  $('#archive-actions-status').textContent = parts.join('・') || '取り直しが必要なものはありません。';
}

async function loadStorage() {
  const archive = state.selectedArchive;
  if (!archive || $('#storage-card').dataset.loadedFor === archive.id) return;
  $('#storage-card').dataset.loadedFor = archive.id;
  $('#storage-total').textContent = '計算中…';
  try {
    const { storage } = await api(`/api/archives/${encodeURIComponent(archive.id)}/storage`);
    if (state.selectedArchive?.id !== archive.id) return;
    const largest = Math.max(1, ...storage.categories.map((item) => item.bytes));
    $('#storage-total').textContent = `合計 ${formatBytes(storage.totalBytes)}`;
    $('#storage-list').replaceChildren(...storage.categories.filter((item) => item.bytes > 0).sort((a, b) => b.bytes - a.bytes).map((item) => {
      const li = document.createElement('li'); li.dataset.key = item.key;
      const row = document.createElement('div'); row.className = 'storage-row';
      const label = document.createElement('span'); label.textContent = item.label;
      const size = document.createElement('strong'); size.textContent = `${formatBytes(item.bytes)}（${Math.round((item.bytes / Math.max(1, storage.totalBytes)) * 100)}%）`;
      row.append(label, size);
      const bar = document.createElement('div'); bar.className = 'storage-bar';
      const fill = document.createElement('span'); fill.style.width = `${Math.max(1, Math.round((item.bytes / largest) * 100))}%`;
      bar.append(fill);
      li.append(row, bar);
      return li;
    }));
    uiLog('archive.storage.shown', { archiveId: archive.id });
  } catch (error) {
    delete $('#storage-card').dataset.loadedFor;
    $('#storage-total').textContent = error.message;
  }
}

function renderDiff(diff) {
  const card = $('#diff-card');
  card.hidden = !diff;
  if (!diff) return;
  $('#diff-summary').textContent = `追加${diff.added.length}・削除${diff.removed.length}・変更${diff.changed.length}・変更なし${diff.unchangedCount}ページ`;
  const section = (title, items, clickable) => {
    if (!items.length) return null;
    const wrapper = document.createElement('div');
    const heading = document.createElement('h3'); heading.textContent = `${title}（${items.length}）`;
    const list = document.createElement('ul');
    for (const item of items.slice(0, 200)) {
      const li = document.createElement('li');
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
      button.textContent = item.title ? `${item.title} — ${item.url}` : item.url;
      button.title = item.url;
      if (clickable) {
        const count = document.createElement('span'); count.className = 'diff-count'; count.textContent = ` +${item.added} / -${item.removed}`;
        button.append(count);
        button.addEventListener('click', () => openPageDiff(item.url));
      } else button.addEventListener('click', () => navigateReplay(item.url));
      li.append(button); list.append(li);
    }
    wrapper.append(heading, list);
    return wrapper;
  };
  $('#diff-lists').replaceChildren(...[section('変更されたページ', diff.changed, true), section('追加されたページ', diff.added, false), section('なくなったページ', diff.removed, false)].filter(Boolean));
}

async function openPageDiff(url) {
  const archive = state.selectedArchive;
  if (!archive) return;
  try {
    const { diff } = await api(`/api/archives/${encodeURIComponent(archive.id)}/diff-page?url=${encodeURIComponent(url)}`);
    $('#diff-modal-title').textContent = diff.title ? `ページの違い: ${diff.title}` : 'ページの違い';
    $('#diff-modal-url').textContent = url;
    const lines = [];
    let sameRun = [];
    const flushSame = () => {
      if (sameRun.length > 6) {
        lines.push(...sameRun.slice(0, 2), { type: 'gap', text: `（変更のない${sameRun.length - 4}行を省略）` }, ...sameRun.slice(-2));
      } else lines.push(...sameRun);
      sameRun = [];
    };
    for (const op of diff.ops) {
      if (op.type === 'same') { sameRun.push(op); continue; }
      flushSame();
      lines.push(op);
    }
    flushSame();
    $('#diff-modal-lines').replaceChildren(...lines.slice(0, 3000).map((op) => { const li = document.createElement('li'); li.dataset.type = op.type; li.textContent = op.text; return li; }));
    $('#diff-modal').hidden = false;
    $('#diff-modal-close').focus();
    uiLog('archive.diff.page.shown', { archiveId: archive.id, lines: diff.ops.length });
  } catch (error) { toast(error.message); }
}

function renderDiscovered() {
  const job = state.jobs.filter((item) => item.status === 'discovered').sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))[0];
  const region = $('#discovered-region');
  region.hidden = !job;
  if (!job) { delete region.dataset.jobId; return; }
  const hosts = job.discoveryHosts || [];
  $('#discovered-summary').textContent = `${job.discoveredPages || 0}ページ・${hosts.length}サイト`;
  if (region.dataset.jobId === job.id && region.dataset.signature === `${job.updatedAt}`) return;
  region.dataset.jobId = job.id;
  region.dataset.signature = `${job.updatedAt}`;
  $('#discovered-hosts').replaceChildren(...hosts.map((item) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true; input.value = item.host;
    const host = document.createElement('span'); host.className = 'host'; host.textContent = item.host;
    const count = document.createElement('span'); count.className = 'count'; count.textContent = `${item.count}ページ`;
    label.append(input, host, count); li.append(label);
    return li;
  }));
}

async function openRetryDialog() {
  const archive = state.selectedArchive;
  if (!archive) return;
  let plan;
  try { plan = (await api(`/api/archives/${encodeURIComponent(archive.id)}/retry-plan`)).plan; } catch (error) { toast(error.message); return; }
  state.retryPlan = plan;
  const parts = [];
  if (plan.failedPageCount) parts.push(`保存できなかったページ${plan.failedPageCount}件`);
  if (plan.missingResourceCount) parts.push(`取れなかった素材${plan.missingResourceCount}件（自動で取り直す）`);
  if (plan.loginSites.length) parts.push(`ログインが必要だったサイト${plan.loginSites.length}件`);
  $('#retry-modal-summary').textContent = parts.length ? `${parts.join('・')}を、同じアーカイブへ取り直します。` : '取り直す対象はありません。';
  $('#retry-include-failed').checked = true;
  $('#retry-include-failed').disabled = !plan.failedPageCount;
  $('#retry-include-failed-label').textContent = `保存できなかったページを取り直す（${plan.failedPageCount}件）`;
  $('#retry-login-block').hidden = !plan.loginSites.length;
  $('#retry-login-sites').replaceChildren(...plan.loginSites.map((site) => {
    const li = document.createElement('li');
    const label = document.createElement('span'); label.textContent = `${site.host}（${site.count}ページ）`; label.title = site.sample.join('\n');
    const select = document.createElement('select'); select.dataset.host = site.host;
    select.setAttribute('aria-label', `${site.host}の扱い`);
    for (const [value, text] of [['skip', '未ログインのまま残す'], ['login', 'ログインして保存し直す']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option); }
    select.addEventListener('change', syncRetryDialog);
    li.append(label, select);
    return li;
  }));
  const profiles = (state.logins || []).filter((login) => login.status !== 'waiting');
  $('#retry-login-profile').replaceChildren(...profiles.map((login) => { const option = document.createElement('option'); option.value = login.id; option.textContent = login.name; return option; }));
  syncRetryDialog();
  $('#retry-modal').hidden = false;
  $('#retry-cancel').focus();
  uiLog('modal.shown', { modal: 'retry', loginSites: plan.loginSites.length, failed: plan.failedPageCount });
}

function syncRetryDialog() {
  const wantsLogin = $$('#retry-login-sites select').some((select) => select.value === 'login');
  const hasProfiles = $('#retry-login-profile').options.length > 0;
  $('#retry-profile-field').hidden = !wantsLogin || !hasProfiles;
  $('#retry-profile-note').hidden = !wantsLogin || hasProfiles;
  $('#retry-start').disabled = wantsLogin && !hasProfiles;
}

async function startRetry() {
  const archive = state.selectedArchive;
  if (!archive) return;
  const selects = $$('#retry-login-sites select');
  const body = {
    includeFailed: $('#retry-include-failed').checked,
    loginHosts: selects.filter((select) => select.value === 'login').map((select) => select.dataset.host),
    skipHosts: selects.filter((select) => select.value === 'skip').map((select) => select.dataset.host),
    loginProfileId: $('#retry-login-profile').value || null
  };
  $('#retry-start').disabled = true;
  try {
    const payload = await api(`/api/archives/${encodeURIComponent(archive.id)}/retry`, { method: 'POST', body: JSON.stringify(body) });
    $('#retry-modal').hidden = true;
    state.activeJobId = payload.job.id;
    toast('再保存を開始しました。保存タブで進み具合を確認できます。');
    uiLog('archive.retry.requested', { archiveId: archive.id, loginHosts: body.loginHosts.length, skipHosts: body.skipHosts.length });
    await refresh({ forceArchives: true });
    showView('save');
  } catch (error) { toast(error.message); $('#retry-start').disabled = false; }
}

function applyReplayViewport() {
  const frame = $('#replay-frame');
  const button = $('#replay-size');
  const width = Number(state.manifest?.options?.viewportWidth);
  const height = Number(state.manifest?.options?.viewportHeight);
  const available = Number.isFinite(width) && width >= 320 && Number.isFinite(height) && height >= 200;
  button.disabled = !available || !state.manifest?.pages?.length;
  const original = available && button.getAttribute('aria-pressed') === 'true';
  frame.parentElement.classList.toggle('original-viewport', original);
  frame.style.width = original ? `${width}px` : '';
  frame.style.height = original ? `${height}px` : '';
  button.dataset.tooltip = original ? `保存時の表示：${width} × ${height}。クリックで枠に合わせる` : '保存時の画面サイズで表示';
  uiLog('replay.viewport.changed', { original, width: original ? width : null, height: original ? height : null });
}

function retrySummary(retries) {
  const items = Object.values(retries || {});
  if (!items.length) return 'なし';
  const recovered = items.filter((item) => item.status === 'recovered').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const waiting = items.filter((item) => item.status === 'retrying').length;
  return `${items.length}件（回復${recovered}・失敗${failed}${waiting ? `・取り直し中${waiting}` : ''}）`;
}

function renderIssueReport() {
  const card = $('#issue-report-card');
  const report = state.issueReport;
  card.hidden = !report || !report.categories?.length;
  if (card.hidden) return;
  $('#issue-report-summary').textContent = report.problemCount
    ? `保存できなかったもの ${report.problemCount}件（保存範囲外 ${report.outOfScopeCount}件は別）`
    : `問題はない（保存範囲外 ${report.outOfScopeCount}件）`;
  $('#issue-report-list').replaceChildren(...report.categories.map((category) => {
    const item = document.createElement('li');
    item.className = 'issue-report-item';
    item.dataset.severity = category.severity;
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const label = document.createElement('strong'); label.textContent = category.label;
    const count = document.createElement('span'); count.className = 'issue-count'; count.textContent = `${category.count}件`;
    summary.append(label, count);
    const explanation = document.createElement('p'); explanation.textContent = category.explanation;
    const advice = document.createElement('p'); advice.className = 'issue-advice'; advice.textContent = `対処: ${category.advice}`;
    const examples = document.createElement('ul'); examples.className = 'issue-examples';
    examples.append(...category.examples.map((example) => {
      const row = document.createElement('li');
      const url = document.createElement('span'); url.className = 'issue-url'; url.textContent = example.url;
      const reason = document.createElement('span'); reason.className = 'issue-reason'; reason.textContent = example.reason;
      row.append(url, reason);
      return row;
    }));
    details.append(summary, explanation, advice, examples);
    details.addEventListener('toggle', () => uiLog('issue-report.toggled', { key: category.key, open: details.open }));
    item.append(details);
    return item;
  }));
}

function renderArchiveMetadata() {
  renderIssueReport();
  const archive = state.selectedArchive;
  if (!archive) return;
  const repairWarning = $('#repair-recovery-warning');
  repairWarning.hidden = !archive.repairRecovery;
  repairWarning.textContent = archive.repairRecovery?.message || '';
  const quality = archive.quality || {};
  const values = [
    archive.startUrl,
    formatDate(archive.savedAt),
    String(archive.pages),
    String(archive.resources),
    formatBytes(archive.bytes),
    qualityLabel(quality),
    `${Number(quality.externalIssueCount || 0)}件（点数に含めない）`,
    `${Number(quality.runtimeMissingCount || 0)}種類`,
    `${Number(quality.serverBoundaryCount || 0)}種類`,
    `${Number(quality.auxiliaryRuntimeMissingCount || 0)}種類`,
    retrySummary(state.manifest?.pageRetries),
    state.manifest?.sharedPages?.length ? `${state.manifest.sharedPages.length}ページ` : 'なし'
  ];
  $$('#archive-metadata dd').forEach((dd, index) => { dd.textContent = values[index]; });
}

function replayAuditActive(audit = state.replayAudit) {
  return ['queued', 'running', 'cancelling'].includes(audit?.status);
}

function replayAuditIssueText(page) {
  const parts = [];
  if (page.visibleBrokenImages) parts.push(`表示画像の破損 ${page.visibleBrokenImages}`);
  if (page.visiblePendingImages) parts.push(`表示画像の未完了 ${page.visiblePendingImages}`);
  if (page.missingResources) parts.push(`未保存素材 ${page.missingResources}`);
  if (page.failedRequests) parts.push(`通信失敗 ${page.failedRequests}`);
  if (page.runtimeErrors) parts.push(`動作エラー ${page.runtimeErrors}`);
  if (page.interactionErrors) parts.push(`操作エラー ${page.interactionErrors}`);
  if (page.interactionSkipped) parts.push(`未検査操作 ${page.interactionSkipped}`);
  if (page.interactionLimitReached) parts.push('操作検査が上限到達');
  return parts.join('・') || (page.status === 'error' ? 'ページを正常に表示できません' : '注意項目あり');
}

function renderReplayAudit() {
  const audit = state.replayAudit;
  const selected = Boolean(state.selectedArchive && state.manifest?.pages?.length);
  const active = replayAuditActive(audit);
  const start = $('#start-replay-audit');
  const cancel = $('#cancel-replay-audit');
  const status = $('#replay-audit-status');
  const progress = $('#replay-audit-progress');
  const issues = $('#replay-audit-issues');
  const notices = $('#replay-audit-notices');
  start.disabled = !selected || active || Boolean(state.selectedArchive?.repairRecovery);
  $('#delete-archive').disabled = !state.selectedArchive || active || Boolean(state.selectedArchive?.repairRecovery);
  cancel.hidden = !active;
  cancel.disabled = audit?.status === 'cancelling';
  issues.replaceChildren();
  if (!audit) {
    status.textContent = selected ? 'まだ検査していません。' : 'アーカイブを選択すると検査できます。';
    notices.hidden = true;
    notices.textContent = '';
    progress.hidden = true;
    issues.hidden = true;
    return;
  }
  const total = Math.max(1, Number(audit.pagesTotal || audit.summary?.totalPages || 1));
  const done = Math.min(total, Number(audit.pagesAudited || 0));
  progress.hidden = false;
  progress.setAttribute('aria-valuemax', String(total));
  progress.setAttribute('aria-valuenow', String(done));
  progress.setAttribute('aria-valuetext', `${done} / ${total}ページ`);
  progress.querySelector('span').style.width = `${Math.round(done / total * 100)}%`;
  const summary = audit.summary || {};
  if (audit.status === 'queued') status.textContent = `検査待ち・全${total}ページ`;
  else if (audit.status === 'running') status.textContent = `${done} / ${total}ページを検査中${audit.currentPageTitle ? `・${audit.currentPageTitle}` : ''}`;
  else if (audit.status === 'cancelling') status.textContent = `${done} / ${total}ページ・停止処理中`;
  else if (audit.status === 'completed') {
    const interactions = Number(summary.interactionCandidates || 0) ? `・安全操作${Number(summary.interactionsTested || 0)}/${Number(summary.interactionCandidates || 0)}` : '';
    status.textContent = `検査済み ${done}ページ・表示正常${Number(summary.healthyPages || 0)}・注意${Number(summary.warningPages || 0)}・エラー${Number(summary.errorPages || 0)}${interactions}`;
  }
  else if (audit.status === 'cancelled') status.textContent = `${done} / ${total}ページで停止しました。`;
  else status.textContent = `検査に失敗・${audit.message || '詳細は診断ログで確認できます。'}`;
  const noticeParts = [];
  if (summary.boundaryResources) noticeParts.push(`外部機能 ${Number(summary.boundaryResources)}回`);
  if (summary.auxiliaryResources) noticeParts.push(`計測系 ${Number(summary.auxiliaryResources)}回`);
  if (summary.isolationEvents) noticeParts.push(`安全な遮断 ${Number(summary.isolationEvents)}回`);
  if (summary.runtimeAdvisories) noticeParts.push(`サイト側の代替処理 ${Number(summary.runtimeAdvisories)}回`);
  if (summary.interactionChanges) noticeParts.push(`操作による状態変化 ${Number(summary.interactionChanges)}件`);
  if (summary.interactionTransient) noticeParts.push(`一時表示操作 ${Number(summary.interactionTransient)}件`);
  notices.textContent = noticeParts.length ? `表示不良に含めない検出：${noticeParts.join('・')}` : '';
  notices.hidden = !noticeParts.length;
  for (const page of audit.issuePages || []) {
    const item = document.createElement('li');
    item.className = page.status === 'error' ? 'error' : 'warning';
    const title = document.createElement('strong'); title.textContent = page.title || page.url || '保存ページ';
    const detail = document.createElement('span'); detail.textContent = replayAuditIssueText(page);
    item.append(title, detail); issues.append(item);
  }
  issues.hidden = !issues.children.length;
}

function deferredMediaName(item) {
  try {
    const url = new URL(item.url);
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname);
  } catch { return item.url; }
}

function deferredMediaDetail(item) {
  const remaining = item.remainingCount ?? item.remainingUrls?.length ?? 0;
  if (item.kind === 'stream') return `配信・残り${remaining}ファイル・保存済み${formatBytes(item.savedBytes || 0)}`;
  return item.expectedBytes ? `動画・音声・約${formatBytes(item.expectedBytes)}` : '動画・音声・容量不明';
}

function renderDeferredMedia() {
  const card = $('#deferred-media-card');
  const items = state.manifest?.deferredMedia || [];
  const task = state.deferredMediaTask;
  card.hidden = !state.selectedArchive || (!items.length && !task);
  if (card.hidden) return;
  const running = task?.status === 'running';
  const blocked = running || Boolean(state.selectedArchive?.repairRecovery);
  $('#save-all-deferred-media').disabled = blocked || !items.length;
  const status = $('#deferred-media-status');
  if (running) status.textContent = `${task.completed + task.failed} / ${task.total}件を保存中・${formatBytes(task.bytes)}`;
  else if (task && task.status !== 'running' && !items.length) status.textContent = `保存完了・${task.completed}件・${formatBytes(task.bytes)}`;
  else if (task?.failed) status.textContent = `${items.length}件が未保存・前回の保存で${task.failed}件が失敗`;
  else status.textContent = `${items.length}件が1件の上限を超えたため未保存`;
  const list = $('#deferred-media-list');
  list.replaceChildren();
  for (const item of items.slice(0, 200)) {
    const row = document.createElement('li');
    const text = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = deferredMediaName(item);
    const detail = document.createElement('span'); detail.textContent = deferredMediaDetail(item);
    text.append(name, detail);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'secondary icon-only'; button.dataset.url = item.url;
    button.setAttribute('aria-label', `${deferredMediaName(item)}を保存`); button.dataset.tooltip = '保存';
    button.disabled = blocked;
    const icon = document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.dataset.icon = 'download'; setIcon(icon, 'download');
    button.append(icon);
    row.append(text, button);
    list.append(row);
  }
  list.hidden = !list.children.length;
}

async function loadDeferredMedia(id = state.selectedArchive?.id) {
  if (!id) return;
  try {
    const payload = await api(`/api/archives/${encodeURIComponent(id)}/deferred-media`);
    if (state.selectedArchive?.id !== id) return;
    const wasRunning = state.deferredMediaTask?.status === 'running';
    state.deferredMediaTask = payload.task;
    if (state.manifest) state.manifest.deferredMedia = payload.items || [];
    renderDeferredMedia();
    if (wasRunning && payload.task && payload.task.status !== 'running') {
      toast(payload.task.failed ? `動画・音声の保存で${payload.task.failed}件が失敗しました。` : `動画・音声を${payload.task.completed}件保存しました。`);
      uiLog('deferred-media.finished', { archiveId: id, status: payload.task.status, completed: payload.task.completed, failed: payload.task.failed, bytes: payload.task.bytes });
      await loadArchives();
    }
  } catch (error) { uiLog('deferred-media.status.failed', { archiveId: id, message: error.message }, 'warn'); }
}

async function saveDeferredMedia(urls = null) {
  const id = state.selectedArchive?.id;
  const items = state.manifest?.deferredMedia || [];
  if (!id || !items.length || state.deferredMediaTask?.status === 'running') return;
  const count = urls ? urls.length : items.length;
  if (!await confirmAction({
    title: '未保存の動画・音声を保存',
    copy: `${count}件を容量の上限なしで取得し、このアーカイブへ追加します。容量が大きい場合は時間とディスク容量を使います。`,
    confirmLabel: '保存'
  })) { uiLog('deferred-media.cancelled', { archiveId: id, count }); return; }
  try {
    const payload = await api(`/api/archives/${encodeURIComponent(id)}/deferred-media`, { method: 'POST', body: JSON.stringify(urls ? { urls } : {}) });
    state.deferredMediaTask = payload.task;
    renderDeferredMedia();
    toast('動画・音声の保存を開始しました。');
    uiLog('deferred-media.started', { archiveId: id, count });
  } catch (error) {
    toast(error.message);
    uiLog('deferred-media.start.failed', { archiveId: id, message: error.message }, 'error');
  }
}

async function loadReplayAudit(id = state.selectedArchive?.id) {
  if (!id) return;
  const token = ++state.replayAuditRequestToken;
  try {
    const payload = await api(`/api/archives/${encodeURIComponent(id)}/replay-audit`);
    if (token !== state.replayAuditRequestToken || state.selectedArchive?.id !== id) return;
    state.replayAudit = payload.audit;
    renderReplayAudit();
  } catch (error) {
    if (token === state.replayAuditRequestToken && state.selectedArchive?.id === id) {
      uiLog('replay-audit.status.failed', { archiveId: id, message: error.message }, 'warn');
    }
  }
}

function startReplayWarmup(archiveId, startUrl) {
  stopReplayWarmup();
  const frame = document.createElement('iframe');
  frame.id = 'replay-warmup';
  frame.hidden = true;
  frame.tabIndex = -1;
  frame.title = '保存済みサイトの事前準備';
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.src = `${replayOriginFor(archiveId)}/archive/${encodeURIComponent(archiveId)}/warm?url=${encodeURIComponent(startUrl || '')}`;
  document.body.append(frame);
  state.warmupArchiveId = archiveId;
  uiLog('replay.warmup.started', { archiveId });
}

function stopReplayWarmup() {
  $('#replay-warmup')?.remove();
  state.warmupArchiveId = null;
}

function signalReplayWarmup(type) {
  const frame = $('#replay-warmup');
  if (!frame?.contentWindow || !state.warmupArchiveId) return;
  try { frame.contentWindow.postMessage({ type }, replayOriginFor(state.warmupArchiveId)); } catch {}
}

function clearArchiveDetail() {
  stopReplayWarmup();
  state.archiveOpenToken += 1;
  state.replayNavigationId += 1;
  clearTimeout(replayDetailsTimer); replayDetailsTimer = null;
  state.selectedArchive = null; state.manifest = null; state.issueReport = null; $('#issue-report-card').hidden = true; state.runtimeMisses = null; state.replayStatus = null; state.replayHistory = []; state.replayIndex = -1; state.replayAudit = null; state.replayAuditRequestToken += 1; state.deferredMediaTask = null;
  $('#replay-size').setAttribute('aria-pressed', 'false'); applyReplayViewport();
  $('#replay-title').textContent = 'アーカイブを選択'; $('#replay-status').textContent = ''; $('#replay-address').textContent = 'ページ未選択'; $('#replay-frame').removeAttribute('src'); $('#replay-frame').setAttribute('aria-busy', 'false');
  $('#repair-recovery-warning').hidden = true; $('#repair-recovery-warning').textContent = '';
  $('#page-list').innerHTML = '<p class="empty-row">保存済みサイトを選ぶと表示されます。</p>';
  $('#crawl-path').replaceChildren(); $$('#archive-metadata dd').forEach((dd) => { dd.textContent = '—'; });
  state.archiveRenderSignature = '';
  ['replay-back', 'replay-forward', 'replay-reload', 'replay-home', 'replay-light', 'delete-archive', 'start-replay-audit'].forEach((id) => { $(`#${id}`).disabled = true; });
  hideHeavyNotice();
  renderReplayAudit();
  renderDeferredMedia();
}

function confirmAction({ title, copy, confirmLabel = '実行' }) {
  if (actionModalResolve) actionModalResolve(false);
  actionModalTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('#action-modal-title').textContent = title;
  $('#action-modal-copy').textContent = copy;
  $('#action-modal-confirm span:last-child').textContent = confirmLabel;
  $('#action-modal-confirm').disabled = false;
  $('#action-modal-cancel').disabled = false;
  $('#action-modal').hidden = false;
  $('#action-modal-cancel').focus();
  uiLog('modal.shown', { modal: 'action', action: confirmLabel });
  return new Promise((resolve) => { actionModalResolve = resolve; });
}

function closeActionModal(result) {
  $('#action-modal').hidden = true;
  const resolve = actionModalResolve; actionModalResolve = null;
  resolve?.(result);
  const trigger = actionModalTrigger; actionModalTrigger = null;
  if (trigger?.isConnected) requestAnimationFrame(() => trigger.focus());
}

async function deleteArchive(id) {
  if (state.deletingArchiveIds.has(id)) return;
  state.deletingArchiveIds.add(id);
  state.archiveRenderSignature = '';
  renderArchives({ force: true });
  const archive = state.archives.find((item) => item.id === id) || (state.selectedArchive?.id === id ? state.selectedArchive : null);
  if (!archive) { state.deletingArchiveIds.delete(id); renderArchives({ force: true }); return; }
  try {
    if (!await confirmAction({
      title: 'アーカイブの削除',
      copy: '保存したページ、画像、動画、WARCが削除されます。この操作は取り消せません。',
      confirmLabel: '削除'
    })) return;
    $('#action-modal-confirm').disabled = true;
    $('#action-modal-cancel').disabled = true;
    $('#action-modal-confirm').setAttribute('aria-busy', 'true');
    if (state.selectedArchive?.id === id) {
      $('#replay-frame').src = 'about:blank';
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    uiLog('archive.delete.requested', { archiveId: id });
    await api(`/api/archives/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (state.selectedArchive?.id === id) clearArchiveDetail();
    await loadArchives(); await refresh(); toast('アーカイブを削除しました。'); uiLog('archive.delete.completed', { archiveId: id });
  } catch (error) { toast(error.message); uiLog('archive.delete.failed', { archiveId: id, message: error.message }, 'error'); }
  finally {
    $('#action-modal-confirm').disabled = false;
    $('#action-modal-cancel').disabled = false;
    $('#action-modal-confirm').removeAttribute('aria-busy');
    state.deletingArchiveIds.delete(id);
    state.archiveRenderSignature = '';
    renderArchives({ force: true });
  }
}

async function openArchive(id, { pageUrl = '' } = {}) {
  const token = ++state.archiveOpenToken;
  state.archiveOpeningId = id;
  state.archiveRenderSignature = '';
  renderArchives({ force: true });
  $('#replay-status').textContent = 'アーカイブを読み込み中…';
  $('#replay-frame').setAttribute('aria-busy', 'true');
  uiLog('archive.open.requested', { archiveId: id });
  try {
    const [payload, auditPayload, mediaPayload] = await Promise.all([
      api(`/api/archives/${encodeURIComponent(id)}?view=summary`),
      api(`/api/archives/${encodeURIComponent(id)}/replay-audit`).catch(() => ({ audit: null })),
      api(`/api/archives/${encodeURIComponent(id)}/deferred-media`).catch(() => ({ task: null }))
    ]);
    if (token !== state.archiveOpenToken) { uiLog('archive.open.superseded', { archiveId: id }); return; }
    state.selectedArchive = payload.archive; state.manifest = payload.manifest; state.runtimeMisses = payload.runtimeMisses; state.replayAudit = auditPayload.audit; state.issueReport = payload.issueReport || null;
    state.deferredMediaTask = mediaPayload.task || null;
    state.replayLight = state.heavyArchives.has(id);
    hideHeavyNotice();
    if (state.replayLight) showHeavyNotice('前回このページが重くなったため、軽量表示で開きました。', false);
    state.replayHistory = []; state.replayIndex = -1; state.replayStatus = null;
    state.archiveOpeningId = null;
    renderArchiveDetail(); showView('archives');
    const firstPage = (pageUrl && payload.manifest.pages?.find((page) => page.url === pageUrl)) || payload.manifest.pages?.find((page) => page.url === payload.manifest.startUrl || page.requestedUrl === payload.manifest.startUrl) || payload.manifest.pages?.[0];
    if (firstPage) navigateReplay(firstPage.url);
    else { $('#replay-frame').removeAttribute('src'); $('#replay-frame').setAttribute('aria-busy', 'false'); }
    uiLog('archive.open.completed', { archiveId: id, pages: payload.manifest.pages?.length || 0 });
  } catch (error) {
    if (token === state.archiveOpenToken) { state.archiveOpeningId = null; state.archiveRenderSignature = ''; renderArchives({ force: true }); $('#replay-status').textContent = '読み込みに失敗'; $('#replay-frame').setAttribute('aria-busy', 'false'); toast(error.message); }
    uiLog('archive.open.failed', { archiveId: id, message: error.message }, 'error');
  }
}

function applyArchivePage(payload, { append = false } = {}) {
  const incoming = Array.isArray(payload.archives) ? payload.archives : [];
  if (append) {
    const merged = new Map(state.archives.map((archive) => [archive.id, archive]));
    for (const archive of incoming) merged.set(archive.id, archive);
    state.archives = [...merged.values()];
  } else state.archives = incoming;
  const page = payload.archivePage || payload.page || {};
  state.archiveTotal = Number(page.total ?? state.archives.length);
  state.archiveHasMore = Boolean(page.hasMore);
  state.archiveRevision = Number(payload.revisions?.archiveRevision ?? state.archiveRevision);
  state.archiveRenderSignature = '';
  renderArchives({ force: true });
}

async function loadArchives({ append = false } = {}) {
  const token = ++state.archiveRequestToken;
  const offset = append ? state.archives.length : 0;
  const loadMore = $('#archive-load-more');
  loadMore.disabled = true;
  loadMore.setAttribute('aria-busy', 'true');
  try {
    const query = new URLSearchParams({ q: state.archiveFilter, offset: String(offset), limit: String(state.archivePageSize) });
    const payload = await api(`/api/archives?${query}`);
    if (token !== state.archiveRequestToken) return;
    applyArchivePage(payload, { append });
    uiLog('archives.loaded', { append, received: payload.archives?.length || 0, total: payload.page?.total || 0, filtered: Boolean(state.archiveFilter) });
  } catch (error) {
    if (token === state.archiveRequestToken) { toast(error.message); uiLog('archives.load.failed', { message: error.message }, 'error'); }
  } finally {
    if (token === state.archiveRequestToken) { loadMore.disabled = false; loadMore.removeAttribute('aria-busy'); }
  }
}

function setConnectionLost(lost) {
  if (Boolean(state.connectionLost) === lost) return;
  state.connectionLost = lost;
  $('#connection-state').hidden = !lost;
  uiLog(lost ? 'connection.lost' : 'connection.restored', {}, lost ? 'warn' : 'info');
  if (!lost) toast('サーバーに再接続しました。');
}

async function refresh({ forceArchives = false } = {}) {
  if (state.refreshInFlight) return state.refreshInFlight;
  state.refreshInFlight = (async () => {
    try {
      if (!state.csrfToken) {
        const query = new URLSearchParams({ view: 'dashboard', q: state.archiveFilter, offset: '0', limit: String(state.archivePageSize) });
        const payload = await api(`/api/bootstrap?${query}`);
        state.csrfToken = payload.csrfToken; state.config = payload.config; state.browser = payload.browser;
        state.jobs = payload.jobs || [];
        state.metrics = payload.metrics || null; state.load = payload.load || null;
        state.stateRevision = Number(payload.revisions?.stateRevision || 0);
        applyArchivePage(payload);
        if (!captureDefaultsApplied) { restoreCaptureSettings(); captureDefaultsApplied = true; }
        $('#engine-status').textContent = payload.browser.available ? `${payload.browser.name}で描画後の状態を保存` : 'HTTP方式で保存';
        $('#browser-detail').textContent = payload.browser.available ? `${payload.browser.name} を隔離起動して描画後の状態を保存できます。` : 'ChromeまたはEdgeが見つからないため、現在はHTTP方式。';
        $('#footer-browser').textContent = payload.browser.available ? `保存エンジン: ${payload.browser.name}` : '保存エンジン: HTTP';
      } else {
        const payload = await api('/api/snapshot');
        state.jobs = payload.jobs || [];
        if (Object.hasOwn(payload, 'metrics')) state.metrics = payload.metrics;
        if (Object.hasOwn(payload, 'load')) state.load = payload.load;
        state.stateRevision = Number(payload.revisions?.stateRevision || state.stateRevision);
        const changed = Number(payload.revisions?.archiveRevision || 0) !== state.archiveRevision;
        if (forceArchives || changed) await loadArchives();
      }
      renderProgress(); renderSystemMetrics(); renderArchives();
      if (state.selectedArchive && replayAuditActive()) await loadReplayAudit(state.selectedArchive.id);
      if (state.selectedArchive && state.deferredMediaTask?.status === 'running') await loadDeferredMedia(state.selectedArchive.id);
      setConnectionLost(false);
    } catch (error) {
      if (error.code === 'SERVER_UNREACHABLE') setConnectionLost(true);
      else { toast(error.message); uiLog('snapshot.failed', { message: error.message }, 'error'); }
    }
    finally { state.refreshInFlight = null; }
  })();
  return state.refreshInFlight;
}

let sameSiteKeywords = [];

function renderSameSiteKeywords() {
  const serialized = sameSiteKeywords.join(',');
  $('#same-site-keywords').value = serialized;
  $('#same-site-keywords').setAttribute('value', serialized);
  const chips = $('#same-site-keyword-chips');
  chips.replaceChildren();
  for (const keyword of sameSiteKeywords) {
    const chip = document.createElement('span'); chip.className = 'keyword-chip'; chip.textContent = keyword;
    const remove = document.createElement('button'); remove.type = 'button'; remove.setAttribute('aria-label', `${keyword}を削除`); remove.dataset.tooltip = '削除';
    const icon = document.createElement('span'); icon.dataset.icon = 'x'; icon.setAttribute('aria-hidden', 'true'); remove.append(icon); setIcon(icon, 'x');
    remove.addEventListener('click', () => { sameSiteKeywords = sameSiteKeywords.filter((value) => value !== keyword); renderSameSiteKeywords(); });
    chip.append(remove); chips.append(chip);
  }
}

function addSameSiteKeyword(rawValue) {
  const genericKeywords = new Set(['www', 'com', 'net', 'org', 'info', 'biz', 'app', 'dev', 'shop', 'store', 'cdn']);
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value) return;
  if (!/^[a-z0-9-]{4,32}$/.test(value) || /^\d+$/.test(value) || genericKeywords.has(value)) throw new Error(`「${value}」は使えません。同一サイト固有の英数字4〜32文字を指定してください。`);
  if (sameSiteKeywords.length >= 10 && !sameSiteKeywords.includes(value)) throw new Error('同一サイト語は10個まで指定できます。');
  if (!sameSiteKeywords.includes(value)) sameSiteKeywords.push(value);
  $('#same-site-keyword-input').value = '';
  renderSameSiteKeywords();
}

function applyCaptureConfig(config) {
  if (config.discoveryMode) $('#discovery-mode').value = config.discoveryMode;
  if (config.discoveryPageLimit) $('#discovery-limit').value = config.discoveryPageLimit;
  if (config.discoveryConcurrency) $('#discovery-concurrency').value = config.discoveryConcurrency;
  if (config.externalMaxDepth !== undefined) $('#external-max-depth').value = config.externalMaxDepth === null ? 'unlimited' : config.externalMaxDepth;
  if (config.concurrency) $('#concurrency').value = config.concurrency;
  if (config.respectRobots !== undefined) $('#respect-robots').checked = config.respectRobots;
  if (config.captureRendered !== undefined) $('#capture-rendered').checked = config.captureRendered;
  syncDiscoveryOptions();
}

const CAPTURE_DEFAULTS = Object.freeze({
    discoveryMode: 'immediate', discoveryPageLimit: 100, discoveryConcurrency: 8, externalMaxDepth: 1, concurrency: 3,
    respectRobots: false, captureRendered: true, requestTimeoutMs: 600000, loadWaitMs: 60000, finalizeGraceMs: 120000,
    initialWaitMs: 1200, networkIdleMs: 2000, networkIdleMaxMs: 120000, scrollEnabled: true,
    scrollDelayMs: 100, scrollStepRatio: 0.7, maxScrollContainers: null, maxScrollStepsPerContainer: null,
    imageWaitMs: 60000, captureSrcsetCandidates: true, screenshotMode: 'full-page',
    interactDuringCapture: true, interactionMaxMs: 180000, maxInteractionsPerPage: 1000,
    hoverDuringCapture: true, hoverMaxMs: 90000, maxHoversPerPage: 300
  });

const activePresetConfig = CAPTURE_DEFAULTS;
const CAPTURE_SETTINGS_KEY = 'webcapture.captureSettings';
const REMEMBERED_FIELDS = ['media-strategy', 'media-speed', 'interaction-limit', 'interaction-mode', 'discovery-method', 'share-pages', 'external-max-depth', 'external-detail', 'media-max-bytes', 'discovery-mode', 'discovery-limit', 'concurrency', 'discovery-concurrency', 'per-host-concurrency', 'per-host-interval', 'distributed-access', 'auto-exclude-account', 'capture-rendered', 'respect-robots'];

function saveCaptureSettings() {
  const fields = {};
  for (const id of REMEMBERED_FIELDS) {
    const control = document.getElementById(id);
    if (control) fields[id] = control.type === 'checkbox' ? control.checked : control.value;
  }
  const scope = $('#capture-form input[name="scope"]:checked')?.value || 'site';
  try { localStorage.setItem(CAPTURE_SETTINGS_KEY, JSON.stringify({ version: 2, fields, scope })); } catch {}
}

function restoreCaptureSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CAPTURE_SETTINGS_KEY) || localStorage.getItem('sitevault.captureSettings') || 'null'); } catch {}
  applyCaptureConfig(activePresetConfig);
  if (!saved) { syncDiscoveryOptions(); return; }
  for (const [id, value] of Object.entries(saved.fields || {})) {
    const control = REMEMBERED_FIELDS.includes(id) ? document.getElementById(id) : null;
    if (!control) continue;
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else if (control.tagName !== 'SELECT' || [...control.options].some((option) => option.value === String(value))) control.value = String(value);
  }
  const scope = $(`#capture-form input[name="scope"][value="${saved.scope === 'external' ? 'external' : 'site'}"]`);
  if (scope) scope.checked = true;
  syncDiscoveryOptions();
  uiLog('capture.settings.restored', { fields: Object.keys(saved.fields || {}).length });
}

function captureAdvancedOptions() {
  return {
    ...activePresetConfig,
    discoveryConcurrency: Number($('#discovery-concurrency').value),
    maxPages: null, maxBytes: null, maxDurationMs: null, sameSiteWarningDepth: null, sameSiteMaxDepth: null,
    externalWarningDepth: null, responseMaxBytes: null, pageMaxBytes: null, maxRedirects: null,
    maxLinksPerPage: null, maxResourcesPerPage: null, maxSrcsetCandidates: null,
    queryPolicy: 'keep', includeUrlPatterns: urlPatternList(uiPrefs.includeUrlPatterns), excludeUrlPatterns: urlPatternList(uiPrefs.excludeUrlPatterns),
    resourceTypes: { stylesheet: true, script: true, image: true, media: true, font: true, xhr: true, other: true },
    warcEnabled: true, warcCompressionLevel: 1, browserReuse: true, disableBrowserCache: false,
    viewportWidth: 1440, viewportHeight: 1000, deviceScaleFactor: 1,
    preserveShadowDom: true, preserveCanvas: true, preserveFormState: true, freezeResponsiveImages: false,
    mediaMaxBytes: $('#media-max-bytes').value === 'unlimited' ? null : Number($('#media-max-bytes').value),
    maxInteractionsPerPage: $('#interaction-limit').value === 'unlimited' ? null : Number($('#interaction-limit').value),
    interactionMode: $('#interaction-mode').value,
    mediaStrategy: $('#media-strategy').value,
    mediaSpeed: $('#media-speed').value,
    discoveryMethod: $('#discovery-method').value
  };
}

function setCaptureUrlError(message = '') {
  const input = $('#capture-url');
  const error = $('#capture-url-error');
  error.textContent = message;
  error.hidden = !message;
  input.setAttribute('aria-invalid', String(Boolean(message)));
  input.classList.toggle('invalid', Boolean(message));
}

function validateCaptureUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return '保存するURLを入力してください。';
  let parsed;
  try { parsed = new URL(value); } catch { return 'URLの形式を確認してください。例: https://example.com'; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return 'http:// または https:// のURLを指定してください。';
  if (!parsed.hostname) return 'ホスト名を含むURLを指定してください。';
  return '';
}

$('#capture-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.submitter || $('#capture-form button[type="submit"]');
  const urlError = validateCaptureUrl($('#capture-url').value);
  setCaptureUrlError(urlError);
  if (urlError) { $('#capture-url').focus(); uiLog('capture.validation.failed', { reason: urlError }, 'warning'); toast(urlError); return; }
  submit.disabled = true; submit.setAttribute('aria-busy', 'true');
  try {
    const scope = new FormData(event.currentTarget).get('scope');
    const payload = await api('/api/jobs', { method: 'POST', body: JSON.stringify({
      url: $('#capture-url').value.trim(),
      options: {
        ...captureAdvancedOptions(),
        followExternal: scope === 'external', respectRobots: $('#respect-robots').checked,
        captureRendered: $('#capture-rendered').checked, sameSiteKeywords: uiPrefs.legacyKeywords ? sameSiteKeywords : [],
        discoveryMode: $('#discovery-mode').value, discoveryPageLimit: Number($('#discovery-limit').value),
        externalMaxDepth: $('#external-max-depth').value === 'unlimited' ? null : Number($('#external-max-depth').value),
        concurrency: Number($('#concurrency').value),
        externalDetail: $('#external-detail').value,
        distributedAccess: $('#distributed-access').checked,
        perHostConcurrency: Number($('#per-host-concurrency').value),
        perHostIntervalMs: Number($('#per-host-interval').value),
        autoExcludeAccountPages: $('#auto-exclude-account').checked,
        loginProfileId: $('#login-profile').value || null,
        sharePages: $('#share-pages').checked
      }
    }) });
    state.activeJobId = payload.job.id; toast('保存を開始しました。'); await refresh();
  } catch (error) { toast(error.message); uiLog('capture.start.failed', { message: error.message }, 'error'); } finally { submit.disabled = false; submit.removeAttribute('aria-busy'); }
});

$$('[data-view-target]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.viewTarget)));
$('#refresh-data').addEventListener('click', () => refresh({ forceArchives: true }));
$('#refresh-archives').addEventListener('click', () => loadArchives());
$('#delete-archive').addEventListener('click', () => { if (state.selectedArchive) deleteArchive(state.selectedArchive.id); });
$('#save-all-deferred-media').addEventListener('click', () => saveDeferredMedia(null));
$('#deferred-media-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-url]');
  if (button && !button.disabled) saveDeferredMedia([button.dataset.url]);
});
$('#start-replay-audit').addEventListener('click', async () => {
  const id = state.selectedArchive?.id;
  if (!id || replayAuditActive()) return;
  const button = $('#start-replay-audit');
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  try {
    const payload = await api(`/api/archives/${encodeURIComponent(id)}/replay-audit`, { method: 'POST', body: '{}' });
    if (state.selectedArchive?.id !== id) return;
    state.replayAudit = payload.audit; renderReplayAudit();
    toast('全ページ表示検査を開始しました。'); uiLog('replay-audit.started', { archiveId: id, pages: payload.audit?.pagesTotal || 0 });
  } catch (error) { toast(error.message); uiLog('replay-audit.start.failed', { archiveId: id, message: error.message }, 'error'); }
  finally { button.removeAttribute('aria-busy'); renderReplayAudit(); }
});
$('#cancel-replay-audit').addEventListener('click', async () => {
  const id = state.selectedArchive?.id;
  if (!id || !replayAuditActive()) return;
  try {
    const payload = await api(`/api/archives/${encodeURIComponent(id)}/replay-audit/cancel`, { method: 'POST', body: '{}' });
    if (state.selectedArchive?.id !== id) return;
    state.replayAudit = payload.audit; renderReplayAudit(); uiLog('replay-audit.cancelled', { archiveId: id });
  } catch (error) { toast(error.message); uiLog('replay-audit.cancel.failed', { archiveId: id, message: error.message }, 'error'); }
});
$('#pause-job').addEventListener('click', async () => {
  const job = activeJob(); if (!job) return;
  try { await api(`/api/jobs/${encodeURIComponent(job.id)}/${job.status === 'paused' ? 'resume' : 'pause'}`, { method: 'POST', body: '{}' }); await refresh(); } catch (error) { toast(error.message); }
});
$('#paused-jobs').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-job-action]');
  if (!button || button.disabled) return;
  const { jobId, jobAction } = button.dataset;
  if (jobAction === 'cancel' && !await confirmAction({ title: '保存を停止', copy: 'この保存を終了します。ここまで保存したページはアーカイブに残ります。', confirmLabel: '停止' })) return;
  button.disabled = true;
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}/${jobAction}`, { method: 'POST', body: '{}' });
    if (jobAction === 'resume') state.activeJobId = jobId;
    uiLog(`job.${jobAction}.requested`, { jobId, source: 'paused-list' });
    await refresh();
  } catch (error) { toast(error.message); uiLog(`job.${jobAction}.failed`, { jobId, message: error.message }, 'error'); button.disabled = false; }
});
$('#cancel-job').addEventListener('click', async () => { const job = activeJob(); if (!job) return; try { await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: '{}' }); await refresh(); } catch (error) { toast(error.message); } });
$('#warning-stop').addEventListener('click', () => resolveWarning('stop'));
$('#warning-continue').addEventListener('click', () => resolveWarning('continue'));
function syncScopeToggle() {
  const external = $('#capture-form input[name="scope"][value="external"]').checked;
  const toggle = $('#scope-toggle');
  toggle.setAttribute('aria-checked', String(external));
  toggle.dataset.scope = external ? 'external' : 'site';
}
$('#scope-toggle').addEventListener('click', () => {
  const external = !$('#capture-form input[name="scope"][value="external"]').checked;
  const target = $(`#capture-form input[name="scope"][value="${external ? 'external' : 'site'}"]`);
  target.checked = true;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  uiLog('scope.toggled', { scope: external ? 'external' : 'site' });
});

function syncExternalOptions() {
  syncScopeToggle();
  const enabled = new FormData($('#capture-form')).get('scope') === 'external';
  $('#external-max-depth').disabled = !enabled;
}
function syncDiscoveryOptions() {
  const partial = $('#discovery-mode').value === 'partial';
  const discovering = $('#discovery-mode').value !== 'immediate';
  $('#discovery-method-label').hidden = !discovering;
  $('#discovery-method-field').hidden = !discovering;
  $('#media-speed').disabled = $('#media-strategy').value !== 'background';
  $('#discovery-limit').disabled = !partial;
  $('#discovery-limit-label').hidden = !partial;
  $('#discovery-limit-field').hidden = !partial;
}
$$('input[name="scope"]').forEach((input) => input.addEventListener('change', syncExternalOptions));
$('#discovery-mode').addEventListener('change', syncDiscoveryOptions);
$('#media-strategy').addEventListener('change', syncDiscoveryOptions);
$('#advanced-capture-settings').addEventListener('toggle', (event) => uiLog('capture.advanced.toggled', { open: event.currentTarget.open }));
$('#capture-form').addEventListener('change', (event) => {
  const control = event.target;
  if (!control.matches('input,select,textarea') || ['capture-url', 'same-site-keywords', 'low-impact-mode', 'optimize-mode', 'login-profile'].includes(control.id)) return;
  const data = { key: control.id || control.name || 'capture-option' };
  if (control.type === 'checkbox' || control.type === 'radio') data.checked = control.checked;
  else if (control.tagName === 'TEXTAREA') data.patternCount = control.value.split(/\r?\n/).filter((value) => value.trim()).length;
  else data.value = control.value;
  uiLog('capture.option.changed', data);
  saveCaptureSettings();
});
$('#add-same-site-keyword').addEventListener('click', () => { try { addSameSiteKeyword($('#same-site-keyword-input').value); } catch (error) { toast(error.message); } });
$('#same-site-keyword-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); $('#add-same-site-keyword').click(); } });
$('#capture-url').addEventListener('input', () => {
  const suggestion = $('#suggest-same-site-keyword');
  try {
    const labels = new URL($('#capture-url').value).hostname.split('.').flatMap((label) => label.split('-'));
    const value = labels.find((label) => /^[a-z0-9]{4,32}$/i.test(label) && !['www','store','shop'].includes(label.toLowerCase()));
    suggestion.hidden = !uiPrefs.legacyKeywords || !value || sameSiteKeywords.includes(value.toLowerCase());
    suggestion.textContent = value ? `「${value.toLowerCase()}」を同一サイト語に追加` : '';
    suggestion.dataset.value = value?.toLowerCase() || '';
  } catch { suggestion.hidden = true; }
});
$('#suggest-same-site-keyword').addEventListener('click', (event) => { try { addSameSiteKeyword(event.currentTarget.dataset.value); event.currentTarget.hidden = true; } catch (error) { toast(error.message); } });
let archiveSearchTimer = null;
$('#archive-filter').addEventListener('input', (event) => {
  state.archiveFilter = event.currentTarget.value.trim();
  clearTimeout(archiveSearchTimer);
  archiveSearchTimer = setTimeout(() => loadArchives(), 180);
});
$('#archive-filter').addEventListener('search', () => { state.archiveFilter = $('#archive-filter').value.trim(); loadArchives(); });
$('#fulltext-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = $('#fulltext-query').value.trim();
  const box = $('#fulltext-results');
  if (!query) { box.hidden = true; return; }
  uiLog('search.submitted', { terms: query.split(/\s+/).length });
  $('#fulltext-summary').textContent = '検索中…';
  box.hidden = false;
  try {
    const payload = await api(`/api/search?q=${encodeURIComponent(query)}&limit=50`);
    $('#fulltext-summary').textContent = payload.total ? `${payload.total}ページ見つかった${payload.total > payload.results.length ? `（先頭${payload.results.length}件を表示）` : ''}` : '見つかりませんでした。';
    $('#fulltext-list').replaceChildren(...payload.results.map((result) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'fulltext-item';
      const title = document.createElement('strong'); title.textContent = result.title || result.url;
      const site = document.createElement('span'); site.className = 'fulltext-site'; site.textContent = result.archiveTitle;
      const snippet = document.createElement('span'); snippet.className = 'fulltext-snippet'; snippet.textContent = result.snippet;
      button.append(title, site, snippet);
      button.addEventListener('click', () => { uiLog('search.result.opened', { archiveId: result.archiveId }); openArchive(result.archiveId, { pageUrl: result.url }); });
      item.append(button);
      return item;
    }));
  } catch (error) {
    $('#fulltext-summary').textContent = '検索に失敗しました。';
    toast(error.message);
    uiLog('search.failed', { message: error.message }, 'error');
  }
});
$('#fulltext-query').addEventListener('search', () => { if (!$('#fulltext-query').value.trim()) $('#fulltext-results').hidden = true; });
$('#archive-load-more').addEventListener('click', () => loadArchives({ append: true }));
$('#page-filter').addEventListener('input', renderPageList);
$('#replay-back').addEventListener('click', () => { if (state.replayIndex > 0) { state.replayIndex -= 1; navigateReplay(state.replayHistory[state.replayIndex], false); } });
$('#replay-forward').addEventListener('click', () => { if (state.replayIndex < state.replayHistory.length - 1) { state.replayIndex += 1; navigateReplay(state.replayHistory[state.replayIndex], false); } });
$('#replay-reload').addEventListener('click', () => navigateReplay(state.replayHistory[state.replayIndex], false));
function showHeavyNotice(text, offerLight = true) {
  $('#replay-heavy-text').textContent = text;
  $('#replay-heavy-light').hidden = !offerLight || state.replayLight;
  $('#replay-heavy-notice').hidden = false;
}
function hideHeavyNotice() { $('#replay-heavy-notice').hidden = true; }
function setReplayLight(enabled, reason) {
  state.replayLight = enabled;
  if (state.selectedArchive) { if (enabled) state.heavyArchives.add(state.selectedArchive.id); else state.heavyArchives.delete(state.selectedArchive.id); }
  $('#replay-light').setAttribute('aria-pressed', String(enabled));
  uiLog('replay.light.changed', { archiveId: state.selectedArchive?.id, enabled, reason });
  if (state.replayHistory[state.replayIndex]) navigateReplay(state.replayHistory[state.replayIndex], false);
}
$('#replay-light').addEventListener('click', () => { hideHeavyNotice(); setReplayLight(!state.replayLight, 'button'); });
$('#replay-heavy-light').addEventListener('click', () => { hideHeavyNotice(); setReplayLight(true, 'notice'); });
$('#replay-heavy-dismiss').addEventListener('click', hideHeavyNotice);
setInterval(() => {
  if (!state.selectedArchive || state.replayLight || !$('#archives-view').classList.contains('active') || document.visibilityState !== 'visible') return;
  const now = Date.now();
  const silentFor = state.replayBeatAt ? now - state.replayBeatAt : now - (state.replayNavigatedAt || now);
  if (silentFor < (state.replayBeatAt ? 12000 : 40000)) return;
  uiLog('replay.unresponsive', { archiveId: state.selectedArchive.id, silentMs: silentFor, heartbeatSeen: Boolean(state.replayBeatAt) }, 'error');
  setReplayLight(true, 'unresponsive');
  showHeavyNotice('プレビューが応答しなくなったため、スクリプトと動きを止めた軽量表示に切り替えました。', false);
}, 2000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.replayBeatAt) state.replayBeatAt = Date.now(); });
$('#replay-home').addEventListener('click', () => navigateReplay(state.manifest?.startUrl));
$('#replay-size').addEventListener('click', () => { const button = $('#replay-size'); button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') !== 'true')); applyReplayViewport(); });
$('#action-modal-cancel').addEventListener('click', () => closeActionModal(false));
$('#action-modal-confirm').addEventListener('click', () => closeActionModal(true));
function closeHelpPopover({ restoreFocus = true } = {}) {
  if (!helpOpen) return;
  helpOpen = false;
  const trigger = helpTrigger;
  helpTrigger = null;
  hideHelpTip();
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function setSettingsOutput(button, output, expanded, labels) {
  output.hidden = !expanded;
  button.setAttribute('aria-expanded', String(expanded));
  const label = button.querySelector('span:last-child');
  if (label) label.textContent = expanded ? labels.hide : labels.show;
}

const helpTip = document.createElement('div');
helpTip.id = 'help-tip';
helpTip.className = 'help-tip';
helpTip.setAttribute('role', 'tooltip');
helpTip.hidden = true;
document.body.append(helpTip);

function placeNear(element, anchor) {
  const rect = anchor.getBoundingClientRect();
  element.style.left = '0px';
  element.style.top = '0px';
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  const gap = 8;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  const below = rect.bottom + gap;
  const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - gap - height);
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
  element.style.setProperty('--arrow-x', `${Math.round(rect.left + rect.width / 2 - left)}px`);
  element.dataset.side = top < rect.top ? 'above' : 'below';
}

function showHelpTip(button) {
  if ((helpOpen && helpTrigger !== button) || !button.dataset.help) return;
  helpTip.textContent = button.dataset.help;
  helpTip.hidden = false;
  placeNear(helpTip, button);
  button.setAttribute('aria-describedby', 'help-tip');
}

function hideHelpTip({ force = false } = {}) {
  if (helpOpen && !force) return;
  helpTip.hidden = true;
  helpTip.classList.remove('pinned');
  $$('[aria-describedby="help-tip"]').forEach((button) => button.removeAttribute('aria-describedby'));
}

document.addEventListener('mouseover', (event) => { const button = event.target.closest?.('.help-button'); if (button) showHelpTip(button); });
document.addEventListener('mouseout', (event) => { const button = event.target.closest?.('.help-button'); if (button && !button.contains(event.relatedTarget)) hideHelpTip(); });
document.addEventListener('focusin', (event) => { const button = event.target.closest?.('.help-button'); if (button?.matches(':focus-visible')) showHelpTip(button); });
document.addEventListener('focusout', (event) => { if (event.target.closest?.('.help-button')) hideHelpTip(); });
window.addEventListener('scroll', () => { if (helpOpen) closeHelpPopover({ restoreFocus: false }); else hideHelpTip(); }, true);
window.addEventListener('resize', () => { if (helpOpen && helpTrigger?.isConnected) placeNear(helpTip, helpTrigger); else hideHelpTip(); });

document.addEventListener('click', (event) => {
  const button = event.target.closest?.('.help-button');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  if (helpOpen && helpTrigger === button) { closeHelpPopover({ restoreFocus: false }); return; }
  helpOpen = false;
  hideHelpTip({ force: true });
  helpTrigger = button;
  helpOpen = true;
  showHelpTip(button);
  helpTip.classList.add('pinned');
  uiLog('help.shown', { key: button.getAttribute('aria-label') || 'help' });
}, true);
document.addEventListener('pointerdown', (event) => {
  if (helpOpen && !event.target.closest('.help-button') && !event.target.closest('#help-tip')) closeHelpPopover({ restoreFocus: false });
});

function syncLowImpactSwitch(enabled) {
  $('#low-impact-mode').checked = enabled;
  $('#low-impact-state').textContent = enabled ? 'ON' : 'OFF';
}
$('#low-impact-mode').addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const enabled = input.checked;
  syncLowImpactSwitch(enabled);
  lowImpactPending = true;
  input.disabled = true;
  uiLog('low-impact.toggle', { enabled });
  try {
    await saveAppSetting({ lowImpactMode: enabled });
    toast(enabled ? '低負荷モードをONにしました。負荷が高いときは自動で減速します。' : '低負荷モードをOFFにしました。負荷に関係なく設定した速さで保存します。');
  } catch (error) {
    syncLowImpactSwitch(!enabled);
    toast(error.message);
    uiLog('low-impact.toggle.failed', { message: error.message }, 'error');
  } finally {
    lowImpactPending = false;
    input.disabled = false;
    renderSystemMetrics();
  }
});
function renderTuningStatus(job) {
  const line = $('#tuning-status');
  const tuning = job?.options?.optimize ? job.tuning : null;
  line.hidden = !tuning;
  if (!tuning) return;
  const last = tuning.lastReduction;
  const reason = last ? ({ cpu: 'CPU使用率100%', memory: 'メモリ使用率97%以上' })[last.reason] || 'ページのエラー' : '';
  line.textContent = `最適化中：同時保存 ${tuning.capture}（開始${tuning.start?.capture ?? 30}）・構造把握 ${tuning.discovery}（開始${tuning.start?.discovery ?? 64}）・下げた回数 ${tuning.reductionCount || 0}${last ? `（直近: ${reason}で${last.kind === 'capture' ? '同時保存' : '構造把握'}を${last.to}へ）` : ''}`;
}

function syncOptimizeSwitch(settings) {
  const enabled = settings.optimizeMode === true;
  $('#optimize-mode').checked = enabled;
  $('#optimize-state').textContent = enabled ? 'ON' : 'OFF';
  for (const id of ['concurrency', 'discovery-concurrency']) { $(`#${id}`).disabled = enabled; $(`#${id}-lock`).hidden = !enabled; }
  const result = settings.optimized;
  $('#optimize-result').hidden = !result;
  if (result) {
    $('#optimize-result-text').textContent = `前回見つかった最適値：同時保存 ${result.capture}・構造把握 ${result.discovery}（下げた回数 ${result.reductionCount || 0}・${formatDate(result.updatedAt)}）`;
    $('#apply-optimized').dataset.capture = String(result.capture);
    $('#apply-optimized').dataset.discovery = String(result.discovery);
  }
}

function applySettings(settings) {
  state.appSettings = settings;
  $('#notify-on-complete').checked = settings.notifyOnComplete !== false;
  $('#notify-on-complete-state').textContent = settings.notifyOnComplete !== false ? 'ON' : 'OFF';
  if (!lowImpactPending) syncLowImpactSwitch(settings.lowImpactMode !== false);
  if (!optimizePending) syncOptimizeSwitch(settings);
}

function loadAppSettings() {
  return api('/api/settings').then((payload) => applySettings(payload.settings)).catch((error) => uiLog('settings.load.failed', { message: error.message }, 'warn'));
}

async function saveAppSetting(changes) {
  const payload = await api('/api/settings', { method: 'POST', body: JSON.stringify(changes) });
  if (payload.load) state.load = payload.load;
  applySettings(payload.settings);
  return payload.settings;
}

let optimizePending = false;
$('#optimize-mode').addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const enabled = input.checked;
  optimizePending = true;
  input.disabled = true;
  $('#optimize-state').textContent = enabled ? 'ON' : 'OFF';
  uiLog('optimize.toggle', { enabled });
  try {
    await saveAppSetting({ optimizeMode: enabled });
    toast(enabled ? '最適化モードをONにしました。次の保存は同時保存30・構造把握64から始めて、合う数を探します。' : '最適化モードをOFFにしました。詳細設定の数で保存します。');
  } catch (error) {
    input.checked = !enabled;
    toast(error.message);
    uiLog('optimize.toggle.failed', { message: error.message }, 'error');
  } finally {
    optimizePending = false;
    input.disabled = false;
    if (state.appSettings) syncOptimizeSwitch(state.appSettings);
  }
});

$('#apply-optimized').addEventListener('click', async (event) => {
  const capture = Number(event.currentTarget.dataset.capture);
  const discovery = Number(event.currentTarget.dataset.discovery);
  const discoverySelect = $('#discovery-concurrency');
  if (![...discoverySelect.options].some((option) => Number(option.value) === discovery)) {
    const option = new Option(String(discovery), String(discovery));
    const after = [...discoverySelect.options].find((item) => Number(item.value) > discovery);
    discoverySelect.add(option, after || null);
  }
  uiLog('optimize.apply', { capture, discovery });
  try {
    if (state.appSettings?.optimizeMode) await saveAppSetting({ optimizeMode: false });
    $('#concurrency').value = String(capture);
    discoverySelect.value = String(discovery);
    saveCaptureSettings();
    toast(`同時保存 ${capture}・構造把握 ${discovery} を詳細設定に入れました。`);
  } catch (error) {
    toast(error.message);
    uiLog('optimize.apply.failed', { message: error.message }, 'error');
  }
});
$('#notify-on-complete').addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const enabled = input.checked;
  input.disabled = true;
  uiLog('notify.toggle', { enabled });
  try { await saveAppSetting({ notifyOnComplete: enabled }); }
  catch (error) { input.checked = !enabled; toast(error.message); uiLog('notify.toggle.failed', { message: error.message }, 'error'); }
  finally { input.disabled = false; $('#notify-on-complete-state').textContent = input.checked ? 'ON' : 'OFF'; }
});
const LOGIN_METHOD_LABELS = { manual: '専用ブラウザでログイン', paste: 'Cookieを貼り付け', chrome: 'Chromeから読み込み', edge: 'Edgeから読み込み' };
const LOGIN_METHOD_NOTES = {
  manual: '追加を押すと、専用のブラウザで検索ページが開きます。好きなサイト（Xなど）へ移動してログインし、ウィンドウを閉じると登録が完了します。複数のサイトにまとめてログインしても問題ありません。パスワードはWebCaptureを通りません。',
  paste: 'Cookieは拡張機能などで書き出します。「名前=値」の形式のときは、サイトのURLも入れます。',
  chrome: '普段のChromeの、すべてのサイトのログイン状態をコピーします。Chromeのウィンドウをすべて閉じてから追加します。',
  edge: '普段のEdgeの、すべてのサイトのログイン状態をコピーします。Edgeのウィンドウをすべて閉じてから追加します。'
};
function syncLoginForm() {
  const method = $('#login-method').value;
  $('#login-text-field').hidden = method !== 'paste';
  $('#login-url-field').hidden = method !== 'paste';
  $('#login-method-note').textContent = LOGIN_METHOD_NOTES[method] || '';
}
function renderLogins(logins) {
  state.logins = logins;
  const select = $('#login-profile');
  const current = select.value;
  select.replaceChildren(new Option('使わない', ''), ...logins.map((login) => new Option(login.name, login.id)));
  if (logins.some((login) => login.id === current)) select.value = current;
  const list = $('#login-list');
  if (!logins.length) { const empty = document.createElement('li'); empty.className = 'muted'; empty.textContent = '登録はまだありません。'; list.replaceChildren(empty); return; }
  list.replaceChildren(...logins.map((login) => {
    const item = document.createElement('li');
    item.className = 'login-item';
    const text = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = login.name;
    const detail = document.createElement('span');
    detail.className = 'muted';
    detail.textContent = `${LOGIN_METHOD_LABELS[login.method] || login.method}・${login.status === 'waiting' ? 'ログイン用のブラウザを開いている（閉じると登録完了）' : `更新 ${formatDate(login.updatedAt)}`}`;
    text.append(name, detail);
    const actions = document.createElement('div'); actions.className = 'actions';
    if (login.method === 'manual') {
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'secondary icon-only';
      open.setAttribute('aria-label', `${login.name}のログイン用ウィンドウを開く`); open.dataset.tooltip = 'ウィンドウを開く';
      const icon = document.createElement('span'); icon.dataset.icon = 'maximize'; icon.setAttribute('aria-hidden', 'true'); open.append(icon); setIcon(open, 'maximize');
      open.disabled = login.status === 'waiting';
      open.addEventListener('click', async () => {
        uiLog('login.reopen', { id: login.id });
        try { await api(`/api/logins/${encodeURIComponent(login.id)}/open`, { method: 'POST', body: '{}' }); toast('専用のブラウザで検索ページを開きました。好きなサイトでログインしたら、ウィンドウを閉じます。'); loadLogins(); }
        catch (error) { toast(error.message); uiLog('login.reopen.failed', { message: error.message }, 'error'); }
      });
      actions.append(open);
    }
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'secondary danger icon-only';
    remove.setAttribute('aria-label', `${login.name}を削除`); remove.dataset.tooltip = '削除';
    const trash = document.createElement('span'); trash.dataset.icon = 'trash'; trash.setAttribute('aria-hidden', 'true'); remove.append(trash); setIcon(remove, 'trash');
    remove.addEventListener('click', async () => {
      if (!await confirmAction({ title: 'ログイン情報の削除', copy: `「${login.name}」のログイン状態を削除します。保存済みのアーカイブは消えません。`, confirmLabel: '削除' })) return;
      uiLog('login.remove', { id: login.id });
      try { await api(`/api/logins/${encodeURIComponent(login.id)}`, { method: 'DELETE' }); toast('ログイン情報を削除しました。'); loadLogins(); }
      catch (error) { toast(error.message); uiLog('login.remove.failed', { message: error.message }, 'error'); }
    });
    actions.append(remove);
    item.append(text, actions);
    return item;
  }));
}
function loadLogins() {
  return api('/api/logins').then((payload) => renderLogins(payload.logins || [])).catch((error) => uiLog('logins.load.failed', { message: error.message }, 'warn'));
}
$('#login-method').addEventListener('change', () => { syncLoginForm(); uiLog('login.method.changed', { method: $('#login-method').value }); });
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const method = $('#login-method').value;
  const button = $('#login-add');
  const body = { method, name: $('#login-name').value.trim() || LOGIN_METHOD_LABELS[method], siteUrl: method === 'paste' ? $('#login-url').value.trim() : undefined, text: method === 'paste' ? $('#login-text').value : undefined };
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  uiLog('login.add', { method });
  try {
    await api('/api/logins', { method: 'POST', body: JSON.stringify(body) });
    $('#login-text').value = '';
    toast(method === 'manual' ? '専用のブラウザで検索ページを開きました。好きなサイトでログインしたら、ウィンドウを閉じると登録が完了します。' : 'ログイン情報を登録しました。保存画面の「ログイン」で選べます。');
    await loadLogins();
  } catch (error) {
    toast(error.message);
    uiLog('login.add.failed', { method, message: error.message }, 'error');
  } finally { button.disabled = false; button.removeAttribute('aria-busy'); }
});
setInterval(() => { if (state.logins?.some((login) => login.status === 'waiting')) loadLogins(); }, 3000);
syncLoginForm();
loadLogins();
loadAppSettings();
$('#show-diagnostics').addEventListener('click', async () => {
  const button = $('#show-diagnostics');
  const output = $('#diagnostic-output');
  const labels = { show: '最新ログを表示', hide: 'ログを閉じる' };
  if (!output.hidden) {
    setSettingsOutput(button, output, false, labels);
    uiLog('diagnostics.hidden');
    return;
  }
  setSettingsOutput($('#show-metrics'), $('#metrics-output'), false, { show: '負荷履歴を表示', hide: '負荷履歴を閉じる' });
  button.disabled = true;
  try {
    const payload = await api('/api/diagnostics/logs?limit=300');
    output.textContent = payload.logs.map((item) => `${item.timestamp} ${item.level.toUpperCase()} ${item.component}.${item.event} ${JSON.stringify(item.data)}`).join('\n') || '記録はまだありません。';
    setSettingsOutput(button, output, true, labels);
    uiLog('diagnostics.shown', { count: payload.logs.length });
  } catch (error) { toast(error.message); uiLog('diagnostics.show.failed', { message: error.message }, 'error'); }
  finally { button.disabled = false; }
});
$('#show-metrics').addEventListener('click', async () => {
  const button = $('#show-metrics');
  const output = $('#metrics-output');
  const labels = { show: '負荷履歴を表示', hide: '負荷履歴を閉じる' };
  if (!output.hidden) {
    setSettingsOutput(button, output, false, labels);
    uiLog('metrics.hidden');
    return;
  }
  setSettingsOutput($('#show-diagnostics'), $('#diagnostic-output'), false, { show: '最新ログを表示', hide: 'ログを閉じる' });
  button.disabled = true;
  try {
    const payload = await api('/api/diagnostics/metrics?limit=300');
    output.textContent = payload.metrics.map((item) => [
      item.timestamp,
      `CPU ${formatPercent(item.cpu)}`,
      `メモリ ${formatPercent(item.memory)}`,
      `ディスク ${formatPercent(item.disk, 'busyPercent')}`,
      `通信 ${formatRate(item.network)}`,
      `GPU ${formatPercent(item.gpu)}`
    ].join(' | ')).join('\n') || '記録はまだありません。';
    setSettingsOutput(button, output, true, labels);
    uiLog('metrics.shown', { count: payload.metrics.length });
  } catch (error) { toast(error.message); uiLog('metrics.show.failed', { message: error.message }, 'error'); }
  finally { button.disabled = false; }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (helpOpen) closeHelpPopover();
  else if (!$('#action-modal').hidden) closeActionModal(false);
});
window.addEventListener('message', (event) => {
  if (!state.config || !state.selectedArchive || !allowedReplayOrigins().includes(event.origin) || event.source !== $('#replay-frame').contentWindow) return;
  if (!isReplayMessageCurrent(state.replayStatus, event.data || {})) {
    uiLog('replay.message.ignored', { type: event.data?.type || 'unknown', reason: 'stale-document' }, 'warn');
    return;
  }
  if (event.data?.type === 'webcapture-heartbeat') { state.replayBeatAt = Date.now(); return; }
  if (event.data?.type === 'webcapture-heavy') {
    uiLog('replay.heavy', { archiveId: state.selectedArchive.id, busy: event.data.busy, memory: event.data.memory }, 'warn');
    if (!state.replayLight) showHeavyNotice(`このページは処理が重い（CPU ${Number(event.data.busy) || 0}%${event.data.memory ? `・メモリ ${Number(event.data.memory)}MB` : ''}）。軽量表示にすると、スクリプトと動きを止めて表示します。`);
    return;
  }
  const messageType = event.data?.type || 'unknown';
  const messageData = {
    type: messageType,
    navigationId: event.data?.navigationId || null,
    reason: event.data?.reason || null,
    transport: event.data?.transport || null,
    method: event.data?.method || null,
    kind: event.data?.kind || null
  };
  uiLog('replay.message', messageData, ['webcapture-missing', 'webcapture-blocked'].includes(messageType) ? 'warn' : messageType === 'webcapture-runtime-error' ? 'error' : 'info');
  if (event.data?.type === 'webcapture-navigate') {
    let target;
    try { target = new URL(event.data.url); } catch { return; }
    if (!/^https?:$/.test(target.protocol)) return;
    if (event.data.source === 'script') {
      const now = Date.now();
      state.autoNavigations = (state.autoNavigations || []).filter((time) => now - time < 15000);
      const current = state.replayHistory[state.replayIndex];
      if (current && current.split('#')[0] === target.href.split('#')[0]) { uiLog('replay.auto-navigation.ignored', { reason: 'same-page' }, 'warn'); return; }
      if (state.autoNavigations.length >= 3) {
        uiLog('replay.auto-navigation.blocked', { archiveId: state.selectedArchive?.id, count: state.autoNavigations.length }, 'warn');
        showHeavyNotice('このページは自動で別のページへ移動し続けるため、自動の移動を止めました。リンクをクリックすると移動できます。', false);
        return;
      }
      state.autoNavigations.push(now);
    } else state.autoNavigations = [];
    navigateReplay(target.href);
    return;
  }
  if (event.data?.type === 'webcapture-open-file') {
    const path = String(event.data.path || '');
    if (path.startsWith(`/archive/${encodeURIComponent(state.selectedArchive?.id || '')}/`)) window.open(`${replayOriginFor()}${path}`, '_blank', 'noopener');
    return;
  }
  if (event.data?.type === 'webcapture-location') {
    try { if (/^https?:$/.test(new URL(event.data.url).protocol)) $('#replay-address').textContent = event.data.url; } catch {}
    return;
  }
  if (event.data?.type === 'webcapture-static-fallback') {
    state.staticReplayPages.add(`${state.replayStatus.archiveId} ${state.replayStatus.requestedUrl || state.replayStatus.pageUrl}`);
    state.staticReplayPages.add(`${state.replayStatus.archiveId} ${state.replayStatus.pageUrl}`);
    uiLog('replay.static-fallback', { archiveId: state.replayStatus.archiveId, navigationId: state.replayStatus.navigationId }, 'warn');
  }
  if (event.data?.type === 'webcapture-blocked' && event.data?.reason === 'form') toast('保存済みサイトからの送信フォーム操作を安全のため止めました。');
  const next = applyReplayMessage(state.replayStatus, event.data || {});
  if (next !== state.replayStatus) {
    const redirected = next.pageUrl !== state.replayStatus.pageUrl;
    state.replayStatus = next;
    if (redirected) showReplayRedirect(next);
    renderReplayStatus();
    if (['ready', 'error'].includes(next.phase)) {
      $('#replay-frame').setAttribute('aria-busy', 'false');
      if (state.warmupArchiveId !== next.archiveId) startReplayWarmup(next.archiveId, next.pageUrl);
      else setTimeout(() => signalReplayWarmup('webcapture-warm-resume'), 1000);
    }
    scheduleReplayDetails();
  }
});

document.addEventListener('click', (event) => {
  const button = event.target.closest?.('button');
  if (button) uiLog('button.clicked', { key: buttonKey(button), enabled: !button.disabled });
}, true);
window.addEventListener('error', (event) => uiLog('window.error', { message: event.message, source: event.filename, line: event.lineno }, 'error'));
window.addEventListener('unhandledrejection', (event) => uiLog('promise.rejected', { message: String(event.reason?.message || event.reason || 'unknown') }, 'error'));
$('#replay-frame').addEventListener('load', () => {
  $('#replay-frame').setAttribute('aria-busy', 'false');
  if (state.replayStatus?.phase === 'loading') state.replayStatus = { ...state.replayStatus, phase: 'loaded-unverified' };
  renderReplayStatus();
  scheduleReplayDetails();
  uiLog('replay.frame.loaded', { archiveId: state.selectedArchive?.id || null });
});

const systemDarkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.dataset.theme = resolveTheme(uiPrefs.theme, Boolean(systemDarkQuery?.matches));
}
function updateUiPrefs(patch, key) {
  Object.assign(uiPrefs, patch);
  writeUiPrefs(safeStorage(), uiPrefs);
  uiLog('settings.ui.changed', { key });
}
function applyLegacyKeywords() {
  $('#legacy-keyword-block').hidden = !uiPrefs.legacyKeywords;
  $('#legacy-keywords').checked = uiPrefs.legacyKeywords;
  $('#legacy-keywords-state').textContent = uiPrefs.legacyKeywords ? 'ON' : 'OFF';
  if (!uiPrefs.legacyKeywords) $('#suggest-same-site-keyword').hidden = true;
}
function renderUrlPatternSummary() {
  const excluded = urlPatternList(uiPrefs.excludeUrlPatterns).length;
  const included = urlPatternList(uiPrefs.includeUrlPatterns).length;
  $('#url-pattern-summary').textContent = excluded || included ? `除外 ${excluded}件・限定 ${included}件を次の保存から使います。` : '絞り込みはありません。';
}
$('#theme-select').value = uiPrefs.theme;
$('#language-select').value = uiPrefs.language;
$('#exclude-url-patterns').value = uiPrefs.excludeUrlPatterns;
$('#include-url-patterns').value = uiPrefs.includeUrlPatterns;
applyTheme();
applyLegacyKeywords();
renderUrlPatternSummary();
applyLanguage(uiPrefs.language);
systemDarkQuery?.addEventListener?.('change', applyTheme);
$('#theme-select').addEventListener('change', (event) => { updateUiPrefs({ theme: event.currentTarget.value }, 'theme'); applyTheme(); });
$('#language-select').addEventListener('change', (event) => { updateUiPrefs({ language: event.currentTarget.value }, 'language'); applyLanguage(uiPrefs.language); });
$('#legacy-keywords').addEventListener('change', (event) => { updateUiPrefs({ legacyKeywords: event.currentTarget.checked }, 'legacyKeywords'); applyLegacyKeywords(); });
for (const [id, key] of [['exclude-url-patterns', 'excludeUrlPatterns'], ['include-url-patterns', 'includeUrlPatterns']]) {
  $(`#${id}`).addEventListener('input', (event) => { Object.assign(uiPrefs, { [key]: event.currentTarget.value }); writeUiPrefs(safeStorage(), uiPrefs); renderUrlPatternSummary(); });
  $(`#${id}`).addEventListener('change', () => uiLog('settings.ui.changed', { key, patternCount: urlPatternList(uiPrefs[key]).length }));
}

const ADVANCED_IDLE_MS = 15000;
let advancedIdleTimer = null;
function scheduleAdvancedCollapse() {
  clearTimeout(advancedIdleTimer);
  const panel = $('#advanced-capture-settings');
  if (!panel.open) return;
  advancedIdleTimer = setTimeout(() => {
    if (!panel.open) return;
    if (panel.contains(document.activeElement)) panel.querySelector('summary').focus({ preventScroll: true });
    panel.open = false;
    uiLog('capture.advanced.auto_collapsed', { idleMs: ADVANCED_IDLE_MS });
  }, ADVANCED_IDLE_MS);
}
$('#advanced-capture-settings').addEventListener('toggle', scheduleAdvancedCollapse);
for (const type of ['pointermove', 'pointerdown', 'keydown', 'input', 'change', 'focusin', 'wheel']) $('#advanced-capture-settings').addEventListener(type, scheduleAdvancedCollapse, { passive: true });

hydrateIcons();
await refresh();
syncExternalOptions();
syncDiscoveryOptions();
uiLog('application.ready', { version: '4.0.0' });
logVisibleButtons();
async function poll() {
  await refresh();
  if (state.selectedArchive && $('#archives-view').classList.contains('active')) scheduleReplayDetails();
  const busy = state.jobs.some((job) => ['running', 'queued', 'discovering'].includes(job.status)) || replayAuditActive();
  state.pollTimer = setTimeout(poll, busy ? 1500 : 5000);
}
state.pollTimer = setTimeout(poll, 1500);
setInterval(flushDiagnostics, 1000);

$('#storage-card').addEventListener('toggle', (event) => { if (event.currentTarget.open) loadStorage(); });
$('#continue-archive').addEventListener('click', async (event) => {
  const archive = state.selectedArchive;
  if (!archive) return;
  event.currentTarget.disabled = true;
  try {
    const payload = await api(`/api/archives/${encodeURIComponent(archive.id)}/continue`, { method: 'POST', body: '{}' });
    state.activeJobId = payload.job.id;
    toast('続きから保存を開始しました。');
    uiLog('archive.continue.requested', { archiveId: archive.id });
    await refresh({ forceArchives: true });
    showView('save');
  } catch (error) { toast(error.message); }
  finally { event.currentTarget.disabled = false; }
});
$('#retry-archive').addEventListener('click', openRetryDialog);
$('#retry-cancel').addEventListener('click', () => { $('#retry-modal').hidden = true; });
$('#retry-start').addEventListener('click', startRetry);
$('#resave-archive').addEventListener('click', async () => {
  const archive = state.selectedArchive;
  if (!archive) return;
  if (!await confirmAction({ title: '再保存して前回と比べる', copy: '同じ設定でサイトをもう一度保存し、新しいアーカイブを作ります。今のアーカイブは残し、保存後に追加・削除・変更されたページを表示します。', confirmLabel: '再保存' })) return;
  try {
    const payload = await api(`/api/archives/${encodeURIComponent(archive.id)}/resave`, { method: 'POST', body: '{}' });
    state.activeJobId = payload.job.id;
    toast('再保存を開始しました。終わると新しいアーカイブで前回との違いを見られます。');
    uiLog('archive.resave.requested', { archiveId: archive.id });
    await refresh({ forceArchives: true });
    showView('save');
  } catch (error) { toast(error.message); }
});
$('#export-archive').addEventListener('click', async () => {
  const archive = state.selectedArchive;
  if (!archive) return;
  const format = $('#export-format').value;
  if (archive.loggedIn && !await confirmAction({ title: 'ログイン状態で保存したアーカイブ', copy: 'このアーカイブには個人情報が含まれている可能性があります。書き出したファイルを人に渡すときはご注意ください。', confirmLabel: '書き出す' })) return;
  const link = document.createElement('a');
  link.href = `/api/archives/${encodeURIComponent(archive.id)}/export?format=${format}`;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
  toast(format === 'wacz' ? 'WACZ形式で書き出しています。大きいサイトは準備に時間がかかります。' : 'WebCapture形式で書き出しています。');
  uiLog('archive.export.requested', { archiveId: archive.id, format });
});
$('#import-archive').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (event) => {
  const file = event.currentTarget.files?.[0];
  event.currentTarget.value = '';
  if (!file) return;
  toast(`「${file.name}」を読み込み中…`);
  try {
    if (!state.csrfToken) await refresh();
    const response = await fetch('/api/archives/import', { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-webcapture-csrf': state.csrfToken } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error?.message || '読み込みに失敗しました。');
    toast(payload.sharedPagesExcluded ? `読み込みました。ほかのアーカイブと共有していた${payload.sharedPagesExcluded}ページは含まれていません。` : '読み込みました。');
    uiLog('archive.import.completed', { archiveId: payload.archive.id, pages: payload.archive.pages });
    await loadArchives();
    await openArchive(payload.archive.id);
  } catch (error) { toast(error.message); uiLog('archive.import.failed', { message: error.message }, 'error'); }
});
$('#diff-modal-close').addEventListener('click', () => { $('#diff-modal').hidden = true; });
$('#discovered-start').addEventListener('click', async (event) => {
  const jobId = $('#discovered-region').dataset.jobId;
  if (!jobId) return;
  const excludeHosts = $$('#discovered-hosts input').filter((input) => !input.checked).map((input) => input.value);
  event.currentTarget.disabled = true;
  try {
    await api(`/api/jobs/${encodeURIComponent(jobId)}/start-capture`, { method: 'POST', body: JSON.stringify({ excludeHosts }) });
    state.activeJobId = jobId;
    toast('把握した内容で保存を開始しました。');
    uiLog('discovery.capture.requested', { jobId, excludedHosts: excludeHosts.length });
    await refresh();
  } catch (error) { toast(error.message); }
  finally { event.currentTarget.disabled = false; }
});
$('#discovered-discard').addEventListener('click', async () => {
  const jobId = $('#discovered-region').dataset.jobId;
  if (!jobId || !await confirmAction({ title: '把握結果を破棄', copy: '把握した一覧を捨てます。保存はされていないので、アーカイブは作られません。', confirmLabel: '破棄' })) return;
  try { await api(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: '{}' }); await refresh(); } catch (error) { toast(error.message); }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('#diff-modal').hidden) $('#diff-modal').hidden = true;
  if (!$('#retry-modal').hidden) $('#retry-modal').hidden = true;
});
