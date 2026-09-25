// 保存中と再生検査の両方で使う、送信を伴わない安全な操作の実行スクリプト。
export function safeInteractionExpression({ limit = 250, settleMs = 80, deadlineMs = null, maxDepth = 3, representative = false, perGroup = 2 } = {}) {
  const safeLimit = limit === null || limit === Infinity ? 'Infinity' : String(Math.max(1, Number(limit) || 250));
  const prelude = [
    `const __svLimit = ${safeLimit};`,
    `const __svRepresentative = ${representative === true};`,
    `const __svPerGroup = ${Math.max(1, Math.trunc(Number(perGroup) || 2))};`,
    `const __svSettleMs = Math.max(0, ${Number(settleMs) || 0});`,
    `const __svDeadline = ${deadlineMs === null ? 'Infinity' : `Date.now() + ${Math.max(0, Number(deadlineMs) || 0)}`};`,
    `const __svMaxDepth = Math.max(0, ${Math.trunc(Number(maxDepth) || 0)});`
  ].join(' ');
  return `(async () => { ${prelude}` + String.raw`
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const layoutVisible = element => {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 1 && rect.height > 1;
  };
  const radioLabel = element => element.labels && element.labels[0] || null;
  const clickTarget = element => element.matches('input[type="radio"]') && !layoutVisible(element) && radioLabel(element) ? radioLabel(element) : element;
  const targetVisible = element => layoutVisible(clickTarget(element));
  const labelOf = element => String(element.getAttribute('aria-label') || element.getAttribute('title') || radioLabel(element)?.textContent || element.textContent || element.value || element.tagName)
    .replace(/\s+/g, ' ').trim().slice(0, 160);
  const dangerous = /(?:buy|purchase|checkout|pay(?:ment)?|place order|subscribe|sign[ -]?in|sign[ -]?up|register|log[ -]?in|log[ -]?out|account|cart|bag|delete|remove|like|follow|vote|report|share|send|submit|post|download|install|退会|購入|注文|決済|支払|登録|ログイン|サインイン|ログアウト|アカウント|カート|削除|送信|投稿|いいね|フォロー|投票|通報|共有|シェア|ダウンロード)/i;
  const panelWords = /(?:account|cart|bag|menu|アカウント|カート|メニュー)/gi;
  const closeWords = /(?:閉じる|close|dismiss|キャンセル|cancel|×|✕)/i;
  const opensPanel = element => element.matches('[aria-haspopup]:not([aria-haspopup="false"]),[aria-expanded],[aria-controls],[popovertarget]');
  const isDangerous = element => {
    const label = labelOf(element);
    if (!dangerous.test(label)) return false;
    return !opensPanel(element) || dangerous.test(label.replace(panelWords, ' '));
  };
  const eligible = element => {
    if (!(element instanceof HTMLElement) || !targetVisible(element) || element.matches(':disabled,[aria-disabled="true"],[inert] *')) return false;
    if (element.matches('summary') && element.parentElement?.matches('details')) return true;
    if (element.matches('a,area,[role="link"]')) return false;
    if (element.matches('input[type="radio"]')) return Boolean(element.name) && !element.checked && !isDangerous(element);
    if (element.closest('form') && !element.matches('button[type="button"],[role="tab"]:not(button),[role="button"]:not(button)')) return false;
    const role = element.getAttribute('role');
    if (role === 'tab' || role === 'switch') return !isDangerous(element);
    if (!element.matches('button,[role="button"]')) return false;
    if (element instanceof HTMLButtonElement && ['submit', 'reset'].includes(element.type) && element.form) return false;
    if (isDangerous(element)) return false;
    return element.matches('[aria-expanded],[aria-controls],[aria-haspopup],[aria-pressed],[popovertarget],[role="button"],button[class*="slider" i],button[class*="carousel" i],button[class*="accordion" i]')
      || element.matches('button[type="button"]')
      || (element instanceof HTMLButtonElement && !element.form && (
        element.matches('button[class*="tab" i],button[class*="toggle" i],button[class*="menu" i],button[class*="next" i],button[class*="prev" i],button[class*="arrow" i],button[class*="dot" i],button[class*="more" i],button[class*="expand" i],button[class*="drawer" i],button[class*="nav" i],button[class*="thumb" i],button[class*="account" i],button[class*="cart" i]')
        || Boolean(element.closest('nav,[role="tablist"],[role="toolbar"],[class*="carousel" i],[class*="slider" i],[class*="swiper" i],[class*="splide" i],[class*="slick" i],[class*="accordion" i],[class*="gallery" i],[class*="media" i]'))
      ));
  };
  const roots = () => {
    const list = [document];
    const seenRoots = new Set([document]);
    const visit = root => {
      for (const element of root.querySelectorAll('*')) {
        const shadow = element.shadowRoot;
        if (shadow && !seenRoots.has(shadow)) { seenRoots.add(shadow); list.push(shadow); visit(shadow); }
      }
    };
    visit(document);
    for (const shadow of window.__webcaptureShadowRoots || []) {
      if (seenRoots.has(shadow) || !shadow.host || !shadow.host.isConnected) continue;
      seenRoots.add(shadow); list.push(shadow); visit(shadow);
    }
    return list;
  };
  const queryAll = selector => roots().flatMap(root => { try { return [...root.querySelectorAll(selector)]; } catch { return []; } });
  const CONTROLS = 'details > summary, button, [role="button"], [role="tab"], [role="switch"], input[type="radio"]';
  const LAYERS = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const openLayers = () => {
    const layers = queryAll(LAYERS);
    try { layers.push(...queryAll('[popover]:popover-open')); } catch {}
    return [...new Set(layers)].filter(layoutVisible);
  };
  const stateOf = element => {
    const controls = String(element.getAttribute('aria-controls') || '').split(/\s+/).filter(Boolean).map(id => {
      const target = (element.getRootNode().getElementById?.(id)) || document.getElementById(id);
      return target ? { id, hidden: target.hidden, ariaHidden: target.getAttribute('aria-hidden'), open: target.hasAttribute('open') } : { id, missing: true };
    });
    return JSON.stringify({
      open: element.parentElement?.matches('details') ? element.parentElement.open : undefined,
      expanded: element.getAttribute('aria-expanded'), selected: element.getAttribute('aria-selected'),
      pressed: element.getAttribute('aria-pressed'), checked: element.matches('input') ? element.checked : element.getAttribute('aria-checked'), controls
    });
  };
  const kindOf = element => element.matches('summary') ? 'details' : element.matches('input[type="radio"]') ? 'radio' : element.getAttribute('role') || element.tagName.toLowerCase();
  const closeLayer = async layer => {
    const closer = [...layer.querySelectorAll('button,[role="button"]')].find(button => layoutVisible(button) && !button.matches('[type="submit"]') && closeWords.test(labelOf(button)));
    if (closer) { closer.click(); await wait(40); }
    if (layoutVisible(layer)) {
      for (const target of [layer, document.activeElement, document]) target?.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, composed: true }));
      await wait(40);
    }
    if (layoutVisible(layer) && layer instanceof HTMLDialogElement) { try { layer.close(); } catch {} }
    if (layoutVisible(layer) && layer.matches('[popover]')) { try { layer.hidePopover(); } catch {} }
  };
  const seen = new WeakSet(), queue = [], items = [];
  const groupCounts = new Map();
  let representativeSkipped = 0;
  const classKey = element => [...element.classList].map(name => name.replace(/[0-9]+/g, '#')).sort().join('.');
  const groupOf = element => {
    const container = element.closest('ul,ol,[role="tablist"],[role="listbox"],[role="grid"],[class*="list" i],[class*="grid" i],[class*="carousel" i],[class*="slider" i],[class*="swiper" i],nav,section,article') || element.parentElement;
    const containerKey = container ? container.tagName + '.' + classKey(container) : '';
    return [kindOf(element), element.tagName, element.getAttribute('role') || '', classKey(element), element.getAttribute('aria-haspopup') || '', containerKey].join('|');
  };
  const discover = (initial, depth) => {
    const found = [];
    for (const element of queryAll(CONTROLS)) {
      if (seen.has(element) || !eligible(element)) continue;
      if (depth > 0 && closeWords.test(labelOf(element))) continue;
      if (__svRepresentative) {
        const group = groupOf(element);
        const used = groupCounts.get(group) || 0;
        if (used >= __svPerGroup) { seen.add(element); representativeSkipped += 1; continue; }
        groupCounts.set(group, used + 1);
      }
      seen.add(element);
      found.push({ element, label: labelOf(element), kind: kindOf(element), initial, depth });
    }
    return found;
  };
  const restoreNavigation = [];
  const blockNavigation = event => { if (event.cancelable && !event.hashChange && !event.destination?.sameDocument) event.preventDefault(); };
  try { window.navigation?.addEventListener('navigate', blockNavigation); restoreNavigation.push(() => window.navigation?.removeEventListener('navigate', blockNavigation)); } catch {}
  const originalOpen = window.open;
  try { window.open = () => null; restoreNavigation.push(() => { window.open = originalOpen; }); } catch {}
  const limit = __svLimit;
  let testedCount = 0, skippedCount = 0, transientCount = 0, changedCount = 0, errorCount = 0, nestedCount = 0, openedLayerCount = 0, deepest = 0;
  const budgetLeft = () => testedCount < limit && Date.now() < __svDeadline;
  const explore = async (entry, depth) => {
    const element = entry.element;
    if (!element.isConnected || !targetVisible(element)) {
      const transient = !entry.initial;
      if (transient) transientCount += 1;
      else skippedCount += 1;
      items.push({
        kind: entry.kind, label: entry.label, depth, changed: false, error: '',
        status: transient ? 'transient' : 'skipped',
        reason: transient ? 'control-hidden-after-state-restored' : 'initial-control-became-unavailable'
      });
      return;
    }
    const item = { kind: entry.kind, label: entry.label, depth, changed: false, error: '', status: 'tested', reason: '' };
    const before = stateOf(element);
    const layersBefore = new Set(openLayers());
    const previousTab = element.getAttribute('role') === 'tab' ? document.querySelector('[role="tab"][aria-selected="true"]') : null;
    const scope = element.form || element.getRootNode();
    const previousRadio = element.matches('input[type="radio"]') ? [...(scope.querySelectorAll?.('input[type="radio"]') || [])].find(radio => radio.name === element.name && radio.checked) : null;
    try {
      clickTarget(element).click();
      testedCount += 1;
      deepest = Math.max(deepest, depth);
      await wait(__svSettleMs);
      const after = element.isConnected ? stateOf(element) : 'removed';
      item.changed = before !== after;
      if (item.changed) changedCount += 1;
      const newLayers = openLayers().filter(layer => !layersBefore.has(layer));
      if (newLayers.length) { item.openedLayers = newLayers.length; openedLayerCount += newLayers.length; }
      if (depth < __svMaxDepth && (item.changed || newLayers.length)) {
        const children = discover(false, depth + 1);
        nestedCount += children.length;
        for (const child of children) {
          if (!budgetLeft()) break;
          await explore(child, depth + 1);
        }
      }
      for (const layer of newLayers.reverse()) if (layoutVisible(layer)) await closeLayer(layer);
      if (previousRadio instanceof HTMLElement && previousRadio.isConnected && previousRadio !== element) { clickTarget(previousRadio).click(); await wait(20); }
      else if (element.isConnected && element.matches('summary') && stateOf(element) !== before) { element.click(); await wait(20); }
      else if (element.isConnected && ['true', 'false'].includes(element.getAttribute('aria-expanded')) && stateOf(element) !== before) { element.click(); await wait(20); }
      else if (previousTab instanceof HTMLElement && previousTab !== element && previousTab.isConnected) { previousTab.click(); await wait(20); }
    } catch (error) {
      testedCount += 1;
      errorCount += 1;
      item.error = String(error?.message || error || 'interaction failed').slice(0, 300);
    }
    items.push(item);
  };
  try {
    queue.push(...discover(true, 0));
    let cursor = 0;
    while (cursor < queue.length && budgetLeft()) {
      await explore(queue[cursor++], 0);
      queue.push(...discover(false, 0));
    }
    const pendingCount = queue.slice(cursor).filter(entry => entry.element.isConnected && targetVisible(entry.element)).length;
    return {
      discoveredCount: queue.length + nestedCount,
      candidateCount: testedCount + skippedCount + pendingCount,
      testedCount,
      skippedCount,
      transientCount,
      changedCount,
      errorCount,
      nestedCount,
      openedLayerCount,
      deepestLevel: deepest,
      limit: Number.isFinite(limit) ? limit : null,
      representative: __svRepresentative,
      representativeSkipped,
      limitReached: pendingCount > 0 || !budgetLeft() && cursor < queue.length,
      items
    };
  } finally {
    for (const restore of restoreNavigation) { try { restore(); } catch {} }
  }
})()`;
}
