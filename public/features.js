import { compareImageUrls, drawDiffOverlay } from './visual-diff.js';
import { translate } from './i18n.js';

const WEEKDAYS = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];
const FREQUENCY_LABELS = { hourly: '毎時', daily: '毎日', weekly: '毎週' };
const WATCH_INTERVAL_LABELS = { 15: '15分ごと', 60: '1時間ごと', 180: '3時間ごと', 360: '6時間ごと', 720: '12時間ごと', 1440: '1日ごと', 10080: '1週間ごと' };
const BATCH_ENTRY_LABELS = { pending: '順番待ち', running: '保存中', done: '保存済み', failed: '失敗', skipped: '取り消し', paused: '一時停止' };
const BATCH_STATUS_LABELS = { running: '実行中', cancelling: '取り消し中', done: '完了', cancelled: '取り消し済み' };

export function initFeatures(ctx) {
  const { state, $, $$, api, toast, uiLog, setIcon, formatBytes, formatDate } = ctx;
  state.replayView = 'desktop';
  state.replayMobileAvailable = false;
  state.archiveFolder = '';
  state.archiveTag = '';
  const local = { presets: [], notifications: [], unread: 0, batches: [], watches: [], schedules: [], cleanupPlan: null, visual: null, visualImages: {}, historyItems: [], currentPageUrl: '', findQuery: '' };

  const element = (tag, className = '', text = '') => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const iconButton = (icon, label, className = 'secondary icon-only') => {
    const button = element('button', className);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.dataset.tooltip = label;
    button.innerHTML = `<span data-icon="${icon}" aria-hidden="true"></span>`;
    setIcon(button, icon);
    return button;
  };
  const archiveId = () => state.selectedArchive?.id || '';
  const pageExt = (url) => { try { return new URL(url).hostname; } catch { return url; } };

  // お知らせ
  function renderNotifications() {
    const count = $('#notifications-count');
    count.hidden = !local.unread;
    count.textContent = local.unread > 99 ? '99+' : String(local.unread);
    $('#notifications-button').setAttribute('aria-label', local.unread ? `お知らせ（未読${local.unread}件）` : 'お知らせ');
    const list = $('#notifications-list');
    if (!local.notifications.length) { list.replaceChildren(element('li', 'muted', 'お知らせはありません。')); return; }
    list.replaceChildren(...local.notifications.map((item) => {
      const row = element('li', `notification-item${item.read ? '' : ' unread'}`);
      row.dataset.kind = item.kind;
      const title = element('strong', '', item.title);
      const time = element('span', 'muted notification-time', formatDate(item.createdAt));
      const message = element('p', 'notification-message', item.message);
      row.append(title, time, message);
      if (item.archiveId) {
        const open = element('button', 'text-action', 'アーカイブを開く');
        open.type = 'button';
        open.addEventListener('click', () => { closeNotifications(); ctx.openArchive(item.archiveId); });
        row.append(open);
      } else if (item.action === 'cleanup') {
        const open = element('button', 'text-action', '整理案を確認する');
        open.type = 'button';
        open.addEventListener('click', () => { closeNotifications(); ctx.showView('settings'); $('#cleanup-plan').scrollIntoView({ block: 'center' }); });
        row.append(open);
      } else if (item.url) {
        row.append(element('span', 'muted notification-url', item.url));
      }
      return row;
    }));
  }
  async function loadNotifications() {
    try {
      const payload = await api('/api/notifications?limit=50');
      const newest = payload.items[0]?.id;
      if (newest && local.notifications.length && newest !== local.notifications[0]?.id && !payload.items[0].read) toast(`お知らせ: ${payload.items[0].title}`);
      local.notifications = payload.items;
      local.unread = payload.unread;
      renderNotifications();
    } catch {}
  }
  function closeNotifications() {
    $('#notifications-panel').hidden = true;
    $('#notifications-button').setAttribute('aria-expanded', 'false');
  }
  $('#notifications-button').addEventListener('click', async () => {
    const panel = $('#notifications-panel');
    panel.hidden = !panel.hidden;
    $('#notifications-button').setAttribute('aria-expanded', String(!panel.hidden));
    uiLog('notifications.toggled', { open: !panel.hidden, unread: local.unread });
    if (!panel.hidden) await loadNotifications();
  });
  $('#notifications-close').addEventListener('click', closeNotifications);
  $('#notifications-read').addEventListener('click', async () => {
    try {
      const payload = await api('/api/notifications/read', { method: 'POST', body: '{}' });
      local.notifications = payload.items;
      local.unread = payload.unread;
      renderNotifications();
    } catch (error) { toast(error.message); }
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !$('#notifications-panel').hidden) closeNotifications(); });

  // プリセット
  function renderPresets() {
    const select = $('#preset-select');
    const current = select.value;
    select.replaceChildren(element('option', '', '選んで呼び出す'));
    select.firstElementChild.value = '';
    const builtIn = element('optgroup');
    builtIn.label = '組み込み';
    const saved = element('optgroup');
    saved.label = '保存したプリセット';
    for (const preset of local.presets) {
      const option = element('option', '', preset.name);
      option.value = preset.id;
      (preset.builtIn ? builtIn : saved).append(option);
    }
    select.append(builtIn);
    if (saved.children.length) select.append(saved);
    select.value = local.presets.some((preset) => preset.id === current) ? current : '';
    $('#preset-delete').disabled = !select.value || Boolean(local.presets.find((preset) => preset.id === select.value)?.builtIn);
  }
  async function loadPresets() {
    try { local.presets = (await api('/api/presets')).presets; renderPresets(); } catch {}
  }
  function presetFieldIds() {
    return [...$$('#capture-form select[id], #capture-form input[id][type="checkbox"], #capture-form input[id][type="number"]')]
      .map((control) => control.id)
      .filter((id) => !['capture-url', 'preset-select', 'login-profile', 'low-impact-mode', 'optimize-mode', 'same-site-keyword-input'].includes(id));
  }
  function applyPreset(preset) {
    let applied = 0;
    for (const [id, value] of Object.entries(preset.fields || {})) {
      const control = document.getElementById(id);
      if (!control || !control.closest('#capture-form')) continue;
      if (control.type === 'checkbox') control.checked = value === true || value === 'true';
      else if (control.tagName === 'SELECT' && ![...control.options].some((option) => option.value === String(value))) continue;
      else control.value = String(value);
      control.dispatchEvent(new Event('change', { bubbles: true }));
      applied += 1;
    }
    if (preset.scope) {
      const target = $(`#capture-form input[name="scope"][value="${preset.scope}"]`);
      if (target) { target.checked = true; target.dispatchEvent(new Event('change', { bubbles: true })); ctx.syncScopeToggle(); }
    }
    ctx.syncDiscoveryOptions();
    ctx.syncExternalOptions();
    ctx.saveCaptureSettings();
    toast(`プリセット「${preset.name}」を呼び出しました（${applied}項目）。`);
    uiLog('preset.applied', { builtIn: Boolean(preset.builtIn), fields: applied });
  }
  $('#preset-select').addEventListener('change', (event) => {
    const preset = local.presets.find((item) => item.id === event.currentTarget.value);
    $('#preset-delete').disabled = !preset || Boolean(preset.builtIn);
    if (preset) applyPreset(preset);
  });
  $('#preset-save').addEventListener('click', async () => {
    const name = window.prompt(translate('プリセットの名前を入力してください。同じ名前があれば上書きします。'), '');
    if (name === null) return;
    const fields = {};
    for (const id of presetFieldIds()) {
      const control = document.getElementById(id);
      fields[id] = control.type === 'checkbox' ? control.checked : control.value;
    }
    const scope = $('#capture-form input[name="scope"]:checked')?.value || 'site';
    try {
      const payload = await api('/api/presets', { method: 'POST', body: JSON.stringify({ name, fields, scope }) });
      local.presets = payload.presets;
      renderPresets();
      $('#preset-select').value = payload.preset.id;
      $('#preset-delete').disabled = false;
      toast(`プリセット「${payload.preset.name}」を保存しました。`);
      uiLog('preset.saved', { fields: Object.keys(fields).length });
    } catch (error) { toast(error.message); }
  });
  $('#preset-delete').addEventListener('click', async () => {
    const preset = local.presets.find((item) => item.id === $('#preset-select').value);
    if (!preset || preset.builtIn) return;
    if (!await ctx.confirmAction({ title: 'プリセットを削除', copy: `プリセット「${preset.name}」を削除します。保存済みのアーカイブには影響しません。`, confirmLabel: '削除' })) return;
    try {
      local.presets = (await api(`/api/presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' })).presets;
      renderPresets();
      toast('プリセットを削除しました。');
    } catch (error) { toast(error.message); }
  });

  // まとめて保存
  function countBatchUrls() {
    const lines = $('#batch-urls').value.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    const valid = lines.filter((value) => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } });
    $('#batch-count').textContent = lines.length ? `URL ${valid.length}件${lines.length > valid.length ? `（URLではない行 ${lines.length - valid.length}件は飛ばします）` : ''}` : '';
    $('#batch-start').disabled = !valid.length;
  }
  $('#batch-open').addEventListener('click', () => {
    $('#batch-modal').hidden = false;
    countBatchUrls();
    $('#batch-urls').focus();
    uiLog('modal.shown', { modal: 'batch' });
  });
  $('#batch-cancel').addEventListener('click', () => { $('#batch-modal').hidden = true; });
  $('#batch-urls').addEventListener('input', countBatchUrls);
  $('#batch-file-choose').addEventListener('click', () => $('#batch-file').click());
  $('#batch-file').addEventListener('change', async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('ファイルが大きすぎます（2MBまで）。'); return; }
    const text = await file.text();
    $('#batch-urls').value = [$('#batch-urls').value.trim(), text.trim()].filter(Boolean).join('\n');
    countBatchUrls();
    uiLog('batch.file.loaded', { bytes: file.size });
  });
  $('#batch-start').addEventListener('click', async () => {
    $('#batch-start').disabled = true;
    try {
      const payload = await api('/api/batches', { method: 'POST', body: JSON.stringify({ text: $('#batch-urls').value, options: ctx.captureFormOptions() }) });
      $('#batch-modal').hidden = true;
      $('#batch-urls').value = '';
      toast(`${payload.batch.total}件の保存を予約しました。上から順番に保存します。${payload.invalid?.length ? `URLではない行 ${payload.invalid.length}件は飛ばしました。` : ''}`);
      uiLog('batch.created', { urls: payload.batch.total, invalid: payload.invalid?.length || 0 });
      await loadBatches();
      await ctx.refresh();
    } catch (error) { toast(error.message); }
    finally { countBatchUrls(); }
  });
  function renderBatches() {
    const active = local.batches.filter((batch) => ['running', 'cancelling'].includes(batch.status) || (batch.finishedAt && Date.now() - new Date(batch.finishedAt).getTime() < 10 * 60 * 1000));
    $('#batch-region').hidden = !active.length;
    if (!active.length) return;
    const batch = active[0];
    $('#batch-summary').replaceChildren(...textParts([BATCH_STATUS_LABELS[batch.status] || batch.status, `${batch.total}件中 ${batch.done}件保存・失敗 ${batch.failed}件・残り ${batch.pending}件`]));
    const list = $('#batch-list');
    const rows = batch.entries.slice(0, 200).map((entry) => {
      const row = element('li', 'batch-entry');
      row.dataset.status = entry.status;
      row.append(element('span', 'batch-entry-status', BATCH_ENTRY_LABELS[entry.status] || entry.status), element('span', 'batch-entry-url', entry.url));
      if (entry.message && entry.status === 'failed') row.append(element('span', 'muted batch-entry-message', entry.message));
      return row;
    });
    if (batch.status === 'running' && batch.pending) {
      const cancel = element('button', 'secondary', '残りの予約を取り消す');
      cancel.type = 'button';
      cancel.addEventListener('click', async () => {
        if (!await ctx.confirmAction({ title: 'まとめて保存を取り消す', copy: `まだ始まっていない${batch.pending}件の保存を取り消します。保存中のものはそのまま最後まで保存します。`, confirmLabel: '取り消す' })) return;
        try { await api(`/api/batches/${encodeURIComponent(batch.id)}/cancel`, { method: 'POST', body: '{}' }); await loadBatches(); }
        catch (error) { toast(error.message); }
      });
      const actionRow = element('li', 'batch-actions');
      actionRow.append(cancel);
      rows.push(actionRow);
    }
    list.replaceChildren(...rows);
  }
  async function loadBatches() {
    try { local.batches = (await api('/api/batches')).batches; renderBatches(); } catch {}
  }

  // アーカイブの絞り込みと整理
  async function loadFacets() {
    try {
      const { facets } = await api('/api/archives/facets');
      const folder = $('#archive-folder-filter');
      const tag = $('#archive-tag-filter');
      folder.replaceChildren(new Option('すべてのフォルダ', ''), new Option(`フォルダなし（${facets.unfiled}件）`, '__none__'), ...facets.folders.map((item) => new Option(`${item.name}（${item.count}件）`, item.name)));
      tag.replaceChildren(new Option('すべてのタグ', ''), ...facets.tags.map((item) => new Option(`#${item.name}（${item.count}件）`, item.name)));
      folder.value = [...folder.options].some((option) => option.value === state.archiveFolder) ? state.archiveFolder : '';
      tag.value = [...tag.options].some((option) => option.value === state.archiveTag) ? state.archiveTag : '';
      $('#archive-folder-options').replaceChildren(...facets.folders.map((item) => new Option(item.name)));
    } catch {}
  }
  $('#archive-folder-filter').addEventListener('change', (event) => { state.archiveFolder = event.currentTarget.value; uiLog('archives.folder.filtered', { active: Boolean(state.archiveFolder) }); ctx.loadArchives(); });
  $('#archive-tag-filter').addEventListener('change', (event) => { state.archiveTag = event.currentTarget.value; uiLog('archives.tag.filtered', { active: Boolean(state.archiveTag) }); ctx.loadArchives(); });
  function renderOrganize() {
    const archive = state.selectedArchive;
    $('#archive-tags').value = (archive?.tags || []).join(', ');
    $('#archive-folder').value = archive?.folder || '';
    $('#archive-note').value = archive?.note || '';
    $('#archive-meta-save').disabled = !archive;
  }
  $('#organize-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = archiveId();
    if (!id) return;
    try {
      const payload = await api(`/api/archives/${encodeURIComponent(id)}/meta`, { method: 'POST', body: JSON.stringify({ tags: $('#archive-tags').value, folder: $('#archive-folder').value, note: $('#archive-note').value }) });
      state.selectedArchive = { ...state.selectedArchive, tags: payload.archive.tags, folder: payload.archive.folder, note: payload.archive.note };
      state.archives = state.archives.map((archive) => archive.id === id ? { ...archive, tags: payload.archive.tags, folder: payload.archive.folder, note: payload.archive.note } : archive);
      renderOrganize();
      await loadFacets();
      toast('整理の内容を保存しました。');
      uiLog('archive.meta.saved', { tags: payload.archive.tags?.length || 0, folder: Boolean(payload.archive.folder) });
    } catch (error) { toast(error.message); }
  });

  // 定期保存
  function syncScheduleForm() {
    const frequency = $('#schedule-frequency').value;
    $('#schedule-weekday-field').hidden = frequency !== 'weekly';
    $('#schedule-time-field').hidden = !frequency;
    $('#schedule-save span:last-child').textContent = frequency ? '定期保存を設定' : '定期保存を止める';
  }
  const textParts = (parts) => parts.filter(Boolean).flatMap((part, index) => index ? [document.createTextNode(' '), element('span', '', part)] : [element('span', '', part)]);
  function scheduleParts(schedule) {
    if (!schedule) return ['定期保存は設定されていません。'];
    const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
    const when = schedule.frequency === 'hourly' ? `毎時${schedule.minute}分` : schedule.frequency === 'weekly' ? `毎週${WEEKDAYS[schedule.weekday]} ${time}` : `毎日 ${time}`;
    return [
      schedule.enabled ? `${when}に保存します。` : '定期保存は止めています。',
      schedule.nextRunAt ? `次回: ${formatDate(schedule.nextRunAt)}` : '',
      schedule.lastResult?.message ? '前回の結果:' : '',
      schedule.lastResult?.message || ''
    ];
  }
  async function loadSchedule() {
    const id = archiveId();
    $('#schedule-save').disabled = !id;
    if (!id) return;
    try {
      const { schedule } = await api(`/api/archives/${encodeURIComponent(id)}/schedule`);
      $('#schedule-frequency').value = schedule?.enabled ? schedule.frequency : '';
      if (schedule) {
        $('#schedule-weekday').value = String(schedule.weekday ?? 0);
        $('#schedule-time').value = `${String(schedule.hour ?? 3).padStart(2, '0')}:${String(schedule.minute ?? 0).padStart(2, '0')}`;
      }
      syncScheduleForm();
      $('#schedule-status').replaceChildren(...textParts(scheduleParts(schedule)));
    } catch (error) { $('#schedule-status').textContent = error.message; }
  }
  $('#schedule-frequency').addEventListener('change', syncScheduleForm);
  $('#schedule-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = archiveId();
    if (!id) return;
    const frequency = $('#schedule-frequency').value;
    const [hour, minute] = String($('#schedule-time').value || '03:00').split(':').map(Number);
    try {
      const existing = local.schedules.find((item) => item.archiveId === id);
      const body = frequency ? { frequency, hour, minute, weekday: Number($('#schedule-weekday').value), enabled: true } : { ...(existing || { frequency: 'daily', hour, minute }), enabled: false };
      const { schedule } = await api(`/api/archives/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: JSON.stringify(body) });
      $('#schedule-status').replaceChildren(...textParts(scheduleParts(schedule)));
      toast(frequency ? '定期保存を設定しました。' : '定期保存を止めました。');
      uiLog('schedule.saved', { frequency: frequency || 'off' });
      await loadSchedules();
    } catch (error) { toast(error.message); }
  });
  async function loadSchedules() {
    try { local.schedules = (await api('/api/schedules')).schedules; renderScheduleList(); } catch {}
  }
  function renderScheduleList() {
    const list = $('#schedule-list');
    if (!local.schedules.length) { list.replaceChildren(element('li', 'muted', '定期保存の予定はありません。')); return; }
    list.replaceChildren(...local.schedules.map((schedule) => {
      const row = element('li', 'login-item');
      const text = element('div');
      const detail = element('span', 'muted');
      detail.append(...textParts(scheduleParts(schedule)));
      text.append(element('strong', '', schedule.title || pageExt(schedule.startUrl)), detail);
      const open = iconButton('archive', 'アーカイブを開く');
      open.addEventListener('click', () => ctx.openArchive(schedule.archiveId));
      const remove = iconButton('trash', '定期保存の予定を削除', 'secondary danger icon-only');
      remove.addEventListener('click', async () => {
        if (!await ctx.confirmAction({ title: '定期保存の予定を削除', copy: '予定を削除します。保存済みのアーカイブは消えません。', confirmLabel: '削除' })) return;
        try { await api(`/api/schedules/${encodeURIComponent(schedule.id)}`, { method: 'DELETE' }); await loadSchedules(); if (schedule.archiveId === archiveId()) await loadSchedule(); }
        catch (error) { toast(error.message); }
      });
      const actions = element('div', 'actions');
      actions.append(open, remove);
      row.append(text, actions);
      return row;
    }));
  }

  // ページ内検索
  function postToReplay(message) {
    try { $('#replay-frame').contentWindow?.postMessage(message, '*'); } catch {}
  }
  function openFind() {
    $('#replay-find-bar').hidden = false;
    $('#replay-find-toggle').setAttribute('aria-pressed', 'true');
    $('#replay-find-input').focus();
    $('#replay-find-input').select();
  }
  function closeFind() {
    $('#replay-find-bar').hidden = true;
    $('#replay-find-toggle').setAttribute('aria-pressed', 'false');
    $('#replay-find-count').textContent = '';
    local.findQuery = '';
    postToReplay({ type: 'webcapture-find', query: '' });
  }
  function runFind(direction = 'next') {
    const query = $('#replay-find-input').value.trim();
    local.findQuery = query;
    if (!query) { $('#replay-find-count').textContent = ''; postToReplay({ type: 'webcapture-find', query: '' }); return; }
    postToReplay({ type: 'webcapture-find', query, direction });
    uiLog('replay.find', { length: query.length, direction });
  }
  $('#replay-find-toggle').addEventListener('click', () => { if ($('#replay-find-bar').hidden) openFind(); else closeFind(); });
  $('#replay-find-bar').addEventListener('submit', (event) => { event.preventDefault(); runFind('next'); });
  $('#replay-find-prev').addEventListener('click', () => runFind('previous'));
  $('#replay-find-close').addEventListener('click', closeFind);
  let findTimer = null;
  $('#replay-find-input').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => runFind('next'), 250); });
  $('#replay-find-input').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); closeFind(); }
    if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); runFind('previous'); }
  });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && $('#archives-view').classList.contains('active') && !$('#replay-find-toggle').disabled) {
      event.preventDefault();
      openFind();
    }
  });

  // PC・スマホ表示の切り替え
  function syncViewToggle() {
    const button = $('#replay-view-toggle');
    const mobile = state.replayView === 'mobile';
    button.disabled = !state.replayMobileAvailable;
    button.setAttribute('aria-pressed', String(mobile && state.replayMobileAvailable));
    const label = mobile ? 'PC表示に切り替え' : 'スマホ表示に切り替え';
    button.setAttribute('aria-label', state.replayMobileAvailable ? label : 'スマホ表示は保存されていません');
    button.dataset.tooltip = state.replayMobileAvailable ? label : 'このページのスマホ表示は保存されていません';
    setIcon(button, mobile && state.replayMobileAvailable ? 'monitor' : 'smartphone');
  }
  $('#replay-view-toggle').addEventListener('click', () => {
    state.replayView = state.replayView === 'mobile' ? 'desktop' : 'mobile';
    uiLog('replay.view.changed', { view: state.replayView });
    ctx.applyReplayViewport();
    syncViewToggle();
    const current = state.replayHistory[state.replayIndex];
    if (current) ctx.navigateReplay(current, false);
  });

  // 日付で見比べる
  function historyFrameUrl(item) {
    const origin = ctx.replayOriginFor(item.archiveId);
    return `${origin}/archive/${encodeURIComponent(item.archiveId)}/page?url=${encodeURIComponent(item.url)}&navigationId=history-${Date.now().toString(36)}&view=desktop`;
  }
  function renderHistoryFrames() {
    const left = local.historyItems[Number($('#history-left').value)];
    const right = local.historyItems[Number($('#history-right').value)];
    if (left) $('#history-frame-left').src = historyFrameUrl(left);
    if (right) $('#history-frame-right').src = historyFrameUrl(right);
    $('#history-open').disabled = !left || left.archiveId === archiveId();
  }
  $('#replay-history').addEventListener('click', async () => {
    const url = local.currentPageUrl;
    if (!url) return;
    $('#history-url').textContent = url;
    $('#history-status').textContent = '過去の保存を探しています…';
    $('#history-modal').hidden = false;
    uiLog('modal.shown', { modal: 'history' });
    try {
      const payload = await api(`/api/pages/history?url=${encodeURIComponent(url)}`);
      local.historyItems = payload.items;
      const options = payload.items.map((item, index) => new Option(`${formatDate(item.savedAt)}（${item.archiveTitle}）`, String(index)));
      $('#history-left').replaceChildren(...options.map((option) => option.cloneNode(true)));
      $('#history-right').replaceChildren(...options);
      const currentIndex = Math.max(0, payload.items.findIndex((item) => item.archiveId === archiveId()));
      $('#history-right').value = String(currentIndex);
      $('#history-left').value = String(payload.items.length > 1 ? (currentIndex + 1 < payload.items.length ? currentIndex + 1 : 0) : currentIndex);
      $('#history-status').textContent = payload.items.length > 1 ? `${payload.items.length}回分の保存があります。左右で日付を選ぶと並べて比べられます。` : 'このページの保存は1回分だけです。同じページを再保存すると日付で見比べられます。';
      renderHistoryFrames();
    } catch (error) { $('#history-status').textContent = error.message; }
  });
  $('#history-left').addEventListener('change', renderHistoryFrames);
  $('#history-right').addEventListener('change', renderHistoryFrames);
  const closeHistory = () => { $('#history-modal').hidden = true; $('#history-frame-left').removeAttribute('src'); $('#history-frame-right').removeAttribute('src'); };
  $('#history-close').addEventListener('click', closeHistory);
  $('#history-open').addEventListener('click', () => {
    const left = local.historyItems[Number($('#history-left').value)];
    if (!left) return;
    closeHistory();
    ctx.openArchive(left.archiveId, { pageUrl: left.url });
  });

  // ページの書き出し
  $('#page-export').addEventListener('click', async () => {
    const id = archiveId();
    const url = local.currentPageUrl;
    if (!id || !url) return;
    const format = $('#page-export-format').value === 'pdf' ? 'pdf' : 'png';
    const button = $('#page-export');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    toast('ページを書き出しています。大きなページは少し時間がかかります。');
    try {
      const response = await fetch(`/api/archives/${encodeURIComponent(id)}/page-export?url=${encodeURIComponent(url)}&format=${format}&view=${state.replayView === 'mobile' && state.replayMobileAvailable ? 'mobile' : 'desktop'}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error?.message || '書き出しに失敗しました。');
      }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${(state.selectedArchive?.title || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      toast(`${format === 'pdf' ? 'PDF' : '画像'}を書き出しました。`);
      uiLog('page.exported', { format, bytes: blob.size });
    } catch (error) { toast(error.message); uiLog('page.export.failed', { message: error.message }, 'warn'); }
    finally { button.disabled = false; button.removeAttribute('aria-busy'); }
  });

  // 見た目の比較
  function imageUrl(id, file) {
    return `/api/archives/${encodeURIComponent(id)}/image?path=${encodeURIComponent(file)}`;
  }
  function renderVisualList() {
    const visual = local.visual;
    const list = $('#visual-list');
    if (!visual?.available) {
      list.replaceChildren();
      $('#visual-viewer').hidden = true;
      $('#visual-status').textContent = '全ページ表示検査を行うと、保存時の画面と再生画面を自動で比べます。';
      return;
    }
    const compared = visual.pages.filter((page) => page.similarity !== null);
    const mismatched = compared.filter((page) => page.mismatch);
    $('#visual-status').textContent = `${compared.length}ページを比べました。見た目が大きく違うページ ${mismatched.length}件（一致率${Math.round(visual.threshold * 100)}%未満）。ページを選ぶと違う場所を表示します。`;
    list.replaceChildren(...visual.pages.slice(0, 50).map((page) => {
      const row = element('li');
      const button = element('button', `visual-item${page.mismatch ? ' mismatch' : ''}`);
      button.type = 'button';
      button.append(element('span', 'visual-score', page.similarity === null ? '—' : `${Math.round(page.similarity * 100)}%`), element('span', 'visual-title', page.title || page.url));
      button.addEventListener('click', () => showVisual(page.url));
      row.append(button);
      return row;
    }));
  }
  async function loadVisual() {
    const id = archiveId();
    local.visual = null;
    if (!id) { renderVisualList(); return; }
    try { local.visual = (await api(`/api/archives/${encodeURIComponent(id)}/visual`)).visual; } catch {}
    renderVisualList();
  }
  async function showVisual(url) {
    const id = archiveId();
    if (!id) return;
    try {
      const { visual } = await api(`/api/archives/${encodeURIComponent(id)}/visual?url=${encodeURIComponent(url)}`);
      const page = visual.page;
      if (!page?.saved || !page?.replay) { toast('このページの比較画像はありません。'); return; }
      $('#visual-viewer').hidden = false;
      $('#visual-page-title').textContent = `${page.title || page.url}（一致率 ${Number.isFinite(page.similarity) ? Math.round(page.similarity * 100) : '—'}%）`;
      const result = Number.isFinite(page.similarity) ? page : await compareImageUrls(imageUrl(id, page.saved), imageUrl(id, page.replay));
      local.visualImages = { id, saved: page.saved, replay: page.replay, result };
      await drawVisual('saved');
      uiLog('visual.shown', { similarity: result.similarity, changed: result.changed?.length || 0 });
    } catch (error) { toast(error.message); }
  }
  async function drawVisual(mode) {
    const { id, saved, replay, result } = local.visualImages;
    if (!id) return;
    const image = new Image();
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error('比較画像を読み込めませんでした。')); image.src = imageUrl(id, mode === 'replay' ? replay : saved); });
    drawDiffOverlay($('#visual-canvas'), image, result, { maxWidth: 900 });
    $('#visual-show-saved').setAttribute('aria-pressed', String(mode !== 'replay'));
    $('#visual-show-replay').setAttribute('aria-pressed', String(mode === 'replay'));
  }
  $('#visual-show-saved').addEventListener('click', () => drawVisual('saved').catch((error) => toast(error.message)));
  $('#visual-show-replay').addEventListener('click', () => drawVisual('replay').catch((error) => toast(error.message)));
  $('#visual-card').addEventListener('toggle', (event) => { if (event.currentTarget.open) loadVisual(); });

  // 失敗理由への対処
  async function runIssueAction(action, label) {
    const id = archiveId();
    if (!id) return;
    if (action === 'retry-login') { ctx.openRetryDialog(); return; }
    const copies = {
      retry: '保存できなかったページと素材を、同じアーカイブへ同じ設定で取り直します。',
      'retry-gentle': '同時保存数を1にし、1ページの待ち時間を長くして、保存できなかったページと素材を取り直します。時間はかかりますが、時間切れを減らせます。',
      'retry-spaced': '同じサイトへのアクセスを1つずつ・5秒の間隔をあけて、保存できなかったページと素材を取り直します。相手サイトの制限を受けにくくなります。'
    };
    if (!await ctx.confirmAction({ title: `${label}への対処`, copy: copies[action] || copies.retry, confirmLabel: '取り直しを開始' })) return;
    try {
      const payload = await api(`/api/archives/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ includeFailed: true, action }) });
      state.activeJobId = payload.job.id;
      toast('取り直しを開始しました。保存タブで進み具合を確認できます。');
      uiLog('issue.action.started', { action });
      await ctx.refresh({ forceArchives: true });
      ctx.showView('save');
    } catch (error) { toast(error.message); }
  }

  // 変化の見張り
  function renderWatches() {
    const list = $('#watch-list');
    if (!local.watches.length) { list.replaceChildren(element('li', 'muted', '見張りはまだありません。')); return; }
    list.replaceChildren(...local.watches.map((watch) => {
      const row = element('li', 'login-item watch-item');
      const text = element('div');
      const statusParts = watch.checking ? ['確認中です。'] : watch.lastError ? [`確認できませんでした: ${watch.lastError}`] : watch.lastCheckedAt ? [`最終確認 ${formatDate(watch.lastCheckedAt)}`, watch.lastChangedAt ? `最後の変化 ${formatDate(watch.lastChangedAt)}` : '変化なし'] : ['まだ確認していません。'];
      const meta = element('span', 'muted');
      meta.append(...textParts([watch.selector ? `部分: ${watch.selector}` : 'ページ全体', WATCH_INTERVAL_LABELS[watch.intervalMinutes] || `${watch.intervalMinutes}分ごと`, watch.enabled ? '' : '停止中']));
      const status = element('span', `muted${watch.lastError ? ' watch-error' : ''}`);
      status.append(...textParts(statusParts));
      text.append(element('strong', '', watch.label || pageExt(watch.url)), meta, status);
      if (watch.lastExcerpt) text.append(element('span', 'watch-excerpt', watch.lastExcerpt));
      const check = iconButton('refresh', '今すぐ確認');
      check.disabled = Boolean(watch.checking);
      check.addEventListener('click', async () => {
        check.disabled = true;
        try { await api(`/api/watches/${encodeURIComponent(watch.id)}/check`, { method: 'POST', body: '{}' }); await loadWatches(); }
        catch (error) { toast(error.message); check.disabled = false; }
      });
      const toggle = iconButton(watch.enabled ? 'pause' : 'play', watch.enabled ? '見張りを止める' : '見張りを再開');
      toggle.addEventListener('click', async () => {
        try { await api(`/api/watches/${encodeURIComponent(watch.id)}`, { method: 'POST', body: JSON.stringify({ enabled: !watch.enabled }) }); await loadWatches(); }
        catch (error) { toast(error.message); }
      });
      const remove = iconButton('trash', '見張りを削除', 'secondary danger icon-only');
      remove.addEventListener('click', async () => {
        if (!await ctx.confirmAction({ title: '見張りを削除', copy: `「${watch.label || watch.url}」の見張りを削除します。`, confirmLabel: '削除' })) return;
        try { await api(`/api/watches/${encodeURIComponent(watch.id)}`, { method: 'DELETE' }); await loadWatches(); }
        catch (error) { toast(error.message); }
      });
      const actions = element('div', 'actions');
      actions.append(check, toggle, remove);
      row.append(text, actions);
      return row;
    }));
  }
  async function loadWatches() {
    try { local.watches = (await api('/api/watches')).watches; renderWatches(); } catch {}
  }
  $('#watch-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const url = $('#watch-url').value.trim();
    const error = ctx.validateCaptureUrl(url);
    if (error) { toast(error); return; }
    try {
      await api('/api/watches', { method: 'POST', body: JSON.stringify({ url, selector: $('#watch-selector').value.trim(), label: $('#watch-label').value.trim(), intervalMinutes: Number($('#watch-interval').value) }) });
      $('#watch-url').value = '';
      $('#watch-selector').value = '';
      $('#watch-label').value = '';
      toast('見張りを追加しました。最初の確認をしています。');
      uiLog('watch.added', { hasSelector: Boolean($('#watch-selector').value) });
      await loadWatches();
      setTimeout(loadWatches, 8000);
    } catch (failure) { toast(failure.message); }
  });

  // 保存データの共有化
  function renderDedupe(task) {
    const status = $('#dedupe-status');
    const button = $('#dedupe-start');
    button.disabled = task?.status === 'running';
    if (!task) { status.textContent = ''; return; }
    if (task.status === 'running') status.replaceChildren(...textParts(['まとめています…', `確認した素材 ${task.scannedFiles}件`, `まとめた素材 ${task.linkedFiles}件`]));
    else if (task.status === 'failed') status.textContent = `まとめられませんでした: ${task.message}`;
    else status.replaceChildren(...textParts([task.message, `減った容量: ${formatBytes(task.savedBytes)}`, `確認した素材 ${task.scannedFiles}件`, task.skippedArchives ? `保存中のため飛ばしたアーカイブ ${task.skippedArchives}件` : '']));
  }
  let dedupeTimer = null;
  async function pollDedupe() {
    try {
      const { task } = await api('/api/storage/dedupe');
      renderDedupe(task);
      if (task?.status === 'running') dedupeTimer = setTimeout(pollDedupe, 1500);
    } catch {}
  }
  $('#dedupe-start').addEventListener('click', async () => {
    try {
      const { task } = await api('/api/storage/dedupe', { method: 'POST', body: '{}' });
      renderDedupe(task);
      uiLog('storage.dedupe.started');
      clearTimeout(dedupeTimer);
      dedupeTimer = setTimeout(pollDedupe, 1000);
    } catch (error) { toast(error.message); }
  });

  // 容量の自動整理
  function syncCleanupSwitch() {
    $('#cleanup-enabled-state').textContent = $('#cleanup-enabled').checked ? 'ON' : 'OFF';
  }
  async function loadCleanup() {
    try {
      const { cleanup } = await api('/api/storage/cleanup');
      $('#cleanup-enabled').checked = cleanup.settings.enabled;
      $('#cleanup-limit').value = String(cleanup.settings.limitGb);
      $('#cleanup-include-warc').checked = cleanup.settings.includeWarc;
      syncCleanupSwitch();
      $('#cleanup-status').textContent = `今の保存データ: ${formatBytes(cleanup.usedBytes)} / 上限 ${formatBytes(cleanup.limitBytes)}${cleanup.overLimit ? '（上限を超えています）' : ''}`;
      if (cleanup.plan) renderCleanupPlan(cleanup.plan);
    } catch {}
  }
  $('#cleanup-enabled').addEventListener('change', syncCleanupSwitch);
  $('#cleanup-save').addEventListener('click', async () => {
    try {
      await api('/api/storage/cleanup/settings', { method: 'POST', body: JSON.stringify({ enabled: $('#cleanup-enabled').checked, limitGb: Number($('#cleanup-limit').value), includeWarc: $('#cleanup-include-warc').checked }) });
      toast('容量の自動整理の設定を保存しました。');
      uiLog('storage.cleanup.saved', { enabled: $('#cleanup-enabled').checked });
      await loadCleanup();
    } catch (error) { toast(error.message); }
  });
  function renderCleanupPlan(plan) {
    local.cleanupPlan = plan;
    const list = $('#cleanup-plan-list');
    list.hidden = false;
    if (!plan.items.length) {
      list.replaceChildren(element('li', 'muted', plan.usedBytes <= plan.limitBytes ? '上限を超えていないため、整理するものはありません。' : '整理できる古いアーカイブの動画・音声が見つかりませんでした。'));
      $('#cleanup-execute').hidden = true;
      return;
    }
    list.replaceChildren(...plan.items.map((item) => {
      const row = element('li', 'login-item');
      const label = element('label', 'cleanup-item');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.value = item.archiveId;
      const text = element('span');
      const detail = element('span', 'muted');
      detail.append(...textParts([formatDate(item.savedAt), `動画・音声 ${item.mediaCount}件（${formatBytes(item.mediaBytes)}）`, item.warcBytes ? `通信記録 ${formatBytes(item.warcBytes)}` : '']));
      text.append(element('strong', '', item.title), detail);
      label.append(box, text);
      row.append(label);
      return row;
    }));
    $('#cleanup-execute').hidden = false;
    $('#cleanup-status').replaceChildren(...textParts([`今の保存データ: ${formatBytes(plan.usedBytes)} / 上限 ${formatBytes(plan.limitBytes)}`, `この整理案で約${formatBytes(plan.freeableBytes)}減らせます。`]));
  }
  $('#cleanup-plan').addEventListener('click', async () => {
    try {
      $('#cleanup-status').textContent = '整理案を作っています…';
      const { plan } = await api('/api/storage/cleanup/plan', { method: 'POST', body: '{}' });
      renderCleanupPlan(plan);
      uiLog('storage.cleanup.planned', { items: plan.items.length });
    } catch (error) { toast(error.message); }
  });
  $('#cleanup-execute').addEventListener('click', async () => {
    const plan = local.cleanupPlan;
    if (!plan) return;
    const archiveIds = $$('#cleanup-plan-list input[type="checkbox"]').filter((box) => box.checked).map((box) => box.value);
    if (!archiveIds.length) { toast('整理するアーカイブを選んでください。'); return; }
    if (!await ctx.confirmAction({ title: '容量を整理', copy: `${archiveIds.length}件のアーカイブから動画・音声${plan.includeWarc ? 'と通信記録' : ''}を消します。ページと画像は残ります。消した動画・音声は後から取り直せる一覧に戻ります。`, confirmLabel: '整理する' })) return;
    try {
      const { result } = await api('/api/storage/cleanup/execute', { method: 'POST', body: JSON.stringify({ planId: plan.id, archiveIds }) });
      toast(`整理しました。約${formatBytes(result.freedBytes)}減りました。`);
      uiLog('storage.cleanup.executed', { archives: archiveIds.length, freedBytes: result.freedBytes });
      $('#cleanup-plan-list').hidden = true;
      $('#cleanup-execute').hidden = true;
      local.cleanupPlan = null;
      await loadCleanup();
      await ctx.refresh({ forceArchives: true });
    } catch (error) { toast(error.message); }
  });

  document.querySelector('[data-view-target="settings"]')?.addEventListener('click', () => { loadWatches(); loadSchedules(); loadCleanup(); pollDedupe(); });

  // 定期的な更新
  async function tick() {
    await Promise.all([loadNotifications(), loadBatches()]);
    if ($('#settings-view').classList.contains('active')) await loadWatches();
  }
  loadPresets();
  loadFacets();
  loadSchedules();
  tick();
  setInterval(tick, 5000);

  return {
    onArchiveOpened() {
      state.replayMobileAvailable = false;
      $('#replay-find-toggle').disabled = !state.manifest?.pages?.length;
      $('#page-export').disabled = true;
      $('#replay-history').disabled = true;
      renderOrganize();
      loadSchedule();
      loadFacets();
      if ($('#visual-card').open) loadVisual(); else { local.visual = null; $('#visual-viewer').hidden = true; $('#visual-list').replaceChildren(); $('#visual-status').textContent = '全ページ表示検査を行うと、保存時の画面と再生画面を自動で比べます。'; }
    },
    onReplayNavigated(page, url) {
      local.currentPageUrl = page?.url || url || '';
      state.replayMobileAvailable = Boolean(page?.mobile);
      $('#page-export').disabled = !page?.html;
      $('#replay-history').disabled = !local.currentPageUrl;
      $('#replay-find-toggle').disabled = !page?.html;
      $('#replay-find-count').textContent = '';
      syncViewToggle();
      ctx.applyReplayViewport();
      const frame = $('#replay-frame');
      if (local.findReload) frame.removeEventListener('load', local.findReload);
      local.findReload = null;
      if (!$('#replay-find-bar').hidden && local.findQuery) {
        local.findReload = () => { local.findReload = null; setTimeout(() => runFind('next'), 300); };
        frame.addEventListener('load', local.findReload, { once: true });
      }
    },
    onFindResult(data) {
      const count = Number(data.count) || 0;
      $('#replay-find-count').textContent = !data.query ? '' : count ? `${Number(data.index) + 1} / ${count}件` : '見つかりません';
    },
    runIssueAction,
    reloadFacets: loadFacets
  };
}
