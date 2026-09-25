export function replayState(archiveId, pageUrl, saved = true, navigationId = null) {
  return { archiveId, pageUrl, requestedUrl: pageUrl, navigationId, redirectable: !saved && navigationId != null, phase: 'loading', missingEvents: 0, runtimeErrors: 0, blockedRequests: 0, message: '' };
}

export function appendReplayHistory(history, index, url) {
  if (!url || history[index] === url) return { history, index };
  const next = history.slice(0, index + 1);
  next.push(url);
  return { history: next, index: next.length - 1 };
}

export function isReplayMessageCurrent(current, message) {
  if (!current || message?.archiveId !== current.archiveId) return false;
  const sameNavigation = current.navigationId == null || String(message?.navigationId || '') === String(current.navigationId);
  if (message?.pageUrl === current.pageUrl) return sameNavigation;
  return Boolean(current.redirectable && current.navigationId != null && sameNavigation && message?.pageUrl);
}

export function applyReplayMessage(current, message) {
  if (!isReplayMessageCurrent(current, message)) return current;
  if (current.redirectable && message.pageUrl !== current.pageUrl) current = { ...current, pageUrl: message.pageUrl, redirectable: false };
  if (message.type === 'webcapture-page-error') return { ...current, phase: 'error', message: String(message.message || 'ページを表示できません') };
  if (message.type === 'webcapture-static-fallback') return { ...current, phase: current.phase === 'error' ? 'error' : 'loading', staticFallback: true };
  if (message.type === 'webcapture-ready' && current.phase !== 'error') return { ...current, phase: 'ready' };
  if (message.type === 'webcapture-missing') return { ...current, missingEvents: current.missingEvents + 1 };
  if (message.type === 'webcapture-runtime-error') return { ...current, runtimeErrors: current.runtimeErrors + 1 };
  if (message.type === 'webcapture-blocked') return { ...current, blockedRequests: Number(current.blockedRequests || 0) + 1 };
  return current;
}

export function replayStateLabel(current) {
  if (!current) return '';
  if (current.phase === 'error') return current.message;
  if (current.phase === 'loading') return '読み込み中…';
  const issues = [
    current.staticFallback ? 'ページのスクリプトが表示を消したため保存時の見た目で表示' : '',
    current.missingEvents ? `保存対象外へのアクセス ${current.missingEvents}回` : '',
    current.runtimeErrors ? `動作エラー ${current.runtimeErrors}件` : '',
    current.blockedRequests ? `送信を安全遮断 ${current.blockedRequests}回` : ''
  ].filter(Boolean);
  return [current.phase === 'ready' ? '表示完了' : '読み込み終了・動作未確認', ...issues].join('・');
}
