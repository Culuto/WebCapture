export function installStyleUrlRewrite(saved) {
  try {
    if (typeof document === 'undefined' || typeof saved !== 'function') return;
    const cssUrl = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    const alreadySaved = (value) => {
      try {
        const resolved = new URL(value, location.href);
        return resolved.origin === location.origin && resolved.pathname.startsWith('/archive/');
      } catch { return true; }
    };
    const rewrite = (css) => {
      if (typeof css !== 'string' || !/url\(/i.test(css)) return css;
      return css.replace(cssUrl, (full, _quote, value) => {
        const trimmed = value.trim();
        if (!trimmed || /^(?:data:|blob:|about:|#|%23)/i.test(trimmed) || alreadySaved(trimmed)) return full;
        try { return `url("${saved(trimmed)}")`; } catch { return full; }
      });
    };
    window.__webcaptureRewriteCssUrls = rewrite;
    const nativeGetAttribute = Element.prototype.getAttribute;
    const nativeSetAttribute = Element.prototype.setAttribute;
    const fixStyleAttribute = (element) => {
      const value = nativeGetAttribute.call(element, 'style');
      if (!value || !/url\(/i.test(value)) return;
      const next = rewrite(value);
      if (next !== value) nativeSetAttribute.call(element, 'style', next);
    };
    const fixStyleText = (styleElement) => {
      for (const node of styleElement.childNodes) {
        if (node.nodeType !== 3 || !/url\(/i.test(node.data)) continue;
        const next = rewrite(node.data);
        if (next !== node.data) node.data = next;
      }
    };
    const fixTree = (node) => {
      if (!node || node.nodeType !== 1) return;
      if (node.localName === 'style') fixStyleText(node);
      if (nativeGetAttribute.call(node, 'style')) fixStyleAttribute(node);
      if (typeof node.querySelectorAll !== 'function') return;
      for (const element of node.querySelectorAll('[style*="url("]')) fixStyleAttribute(element);
      for (const element of node.querySelectorAll('style')) fixStyleText(element);
    };
    const declaration = typeof CSSStyleDeclaration !== 'undefined' ? CSSStyleDeclaration.prototype : null;
    if (declaration) {
      const setProperty = declaration.setProperty;
      if (typeof setProperty === 'function') declaration.setProperty = function (name, value, priority) { return setProperty.call(this, name, rewrite(value), priority); };
      for (const name of ['cssText', 'background', 'backgroundImage', 'borderImage', 'borderImageSource', 'listStyle', 'listStyleImage', 'maskImage', 'webkitMaskImage', 'mask', 'content', 'cursor']) {
        const descriptor = Object.getOwnPropertyDescriptor(declaration, name);
        if (!descriptor?.set || !descriptor.configurable) continue;
        Object.defineProperty(declaration, name, { ...descriptor, set(value) { descriptor.set.call(this, rewrite(value)); } });
      }
    }
    const sheet = typeof CSSStyleSheet !== 'undefined' ? CSSStyleSheet.prototype : null;
    if (sheet) {
      const insertRule = sheet.insertRule;
      if (typeof insertRule === 'function') sheet.insertRule = function (rule, index) { return insertRule.call(this, rewrite(rule), index); };
      const replaceSync = sheet.replaceSync;
      if (typeof replaceSync === 'function') sheet.replaceSync = function (text) { return replaceSync.call(this, rewrite(text)); };
      const replace = sheet.replace;
      if (typeof replace === 'function') sheet.replace = function (text) { return replace.call(this, rewrite(text)); };
    }
    if (typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') fixStyleAttribute(record.target);
        else if (record.type === 'characterData') { if (record.target.parentNode?.localName === 'style') fixStyleText(record.target.parentNode); }
        else {
          if (record.target.localName === 'style') fixStyleText(record.target);
          for (const node of record.addedNodes) fixTree(node);
        }
      }
    });
    const options = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['style'] };
    observer.observe(document, options);
    const attachShadow = Element.prototype.attachShadow;
    if (typeof attachShadow === 'function') {
      Element.prototype.attachShadow = function (init) {
        const root = attachShadow.call(this, init);
        try { observer.observe(root, options); } catch {}
        return root;
      };
    }
    const observeSnapshotRoots = () => { for (const root of window.__webcaptureShadowRoots || []) { try { observer.observe(root, options); } catch {} } };
    if (typeof addEventListener === 'function') addEventListener('load', () => setTimeout(observeSnapshotRoots, 5000), { once: true });
  } catch {}
}

export function installCollapseGuard(staticUrl, report, timing = {}) {
  try {
    if (typeof document === 'undefined' || typeof location === 'undefined' || !staticUrl) return;
    const interval = timing.interval || 600;
    const window_ = timing.window || 20000;
    const strikesNeeded = timing.strikes || 2;
    const skipped = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);
    const measure = () => {
      const body = document.body;
      if (!body) return { text: 0, elements: 0 };
      let text = 0;
      let elements = 0;
      const walker = document.createTreeWalker(body, 5, { acceptNode: (node) => node.nodeType === 1 && skipped.has(node.localName) ? 2 : 1 });
      for (let node = walker.nextNode(); node && elements < 50000; node = walker.nextNode()) {
        if (node.nodeType === 3) text += node.data.trim().length;
        else elements += 1;
      }
      return { text, elements };
    };
    const visibleText = () => { try { return (document.body?.innerText || '').trim().length; } catch { return 0; } };
    let baseline = null;
    let visibleMax = 0;
    let strikes = 0;
    let timer = null;
    let started = 0;
    let done = false;
    const stop = () => { done = true; if (timer) clearInterval(timer); };
    const collapsed = () => {
      const now = measure();
      const visible = visibleText();
      visibleMax = Math.max(visibleMax, visible);
      const textLost = baseline.text >= 200 && now.text < baseline.text * 0.25;
      const elementsLost = baseline.elements >= 200 && now.elements < baseline.elements * 0.25;
      const hidden = visibleMax >= 200 && visible < visibleMax * 0.1;
      return textLost || elementsLost || hidden;
    };
    const check = () => {
      if (done) return;
      if (Date.now() - started > window_) { stop(); return; }
      if (!collapsed()) { strikes = 0; return; }
      strikes += 1;
      if (strikes < strikesNeeded) return;
      stop();
      try { report('webcapture-static-fallback', { reason: 'collapsed' }); } catch {}
      try { location.replace(staticUrl); } catch {}
    };
    const begin = () => {
      if (baseline || done) return;
      baseline = measure();
      visibleMax = visibleText();
      if (baseline.text < 200 && baseline.elements < 200) { stop(); return; }
      started = Date.now();
      timer = setInterval(check, interval);
    };
    for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, (event) => { if (event.isTrusted) stop(); }, { capture: true, once: true, passive: true });
    if (document.readyState === 'loading') document.addEventListener('readystatechange', () => { if (document.readyState !== 'loading') begin(); });
    else begin();
  } catch {}
}

export function installFindInPage(report) {
  const state = { ranges: [], index: -1, query: '' };
  const supported = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
  const ensureStyle = () => {
    if (document.getElementById('webcapture-find-style')) return;
    const style = document.createElement('style');
    style.id = 'webcapture-find-style';
    style.textContent = '::highlight(webcapture-find){background:#fde047;color:#111}::highlight(webcapture-find-current){background:#f97316;color:#111}';
    (document.head || document.documentElement).appendChild(style);
  };
  const clear = () => {
    state.ranges = [];
    state.index = -1;
    if (supported) { CSS.highlights.delete('webcapture-find'); CSS.highlights.delete('webcapture-find-current'); }
  };
  const visible = (node) => {
    const element = node.parentElement;
    if (!element || element.closest('script,style,noscript,template')) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  const collect = (root, needle, ranges) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && ranges.length < 2000; node = walker.nextNode()) {
      const text = node.data.toLowerCase();
      if (!text.includes(needle) || !visible(node)) continue;
      let at = text.indexOf(needle);
      while (at >= 0 && ranges.length < 2000) {
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + needle.length);
        ranges.push(range);
        at = text.indexOf(needle, at + needle.length);
      }
    }
    for (const element of root.querySelectorAll ? root.querySelectorAll('*') : []) if (element.shadowRoot) collect(element.shadowRoot, needle, ranges);
  };
  const show = () => {
    if (!supported) return;
    CSS.highlights.set('webcapture-find', new Highlight(...state.ranges));
    const current = state.ranges[state.index];
    if (current) {
      CSS.highlights.set('webcapture-find-current', new Highlight(current));
      const element = current.startContainer.parentElement;
      element?.scrollIntoView({ block: 'center', inline: 'nearest' });
    } else CSS.highlights.delete('webcapture-find-current');
  };
  const search = (query, direction) => {
    const needle = String(query || '').trim().toLowerCase().slice(0, 200);
    if (!needle) { clear(); state.query = ''; return; }
    if (needle !== state.query || !state.ranges.length || state.ranges.some((range) => !range.startContainer.isConnected)) {
      clear();
      state.query = needle;
      ensureStyle();
      if (document.body) collect(document.body, needle, state.ranges);
      state.index = state.ranges.length ? 0 : -1;
    } else if (state.ranges.length) {
      state.index = (state.index + (direction === 'previous' ? -1 : 1) + state.ranges.length) % state.ranges.length;
    }
    if (!supported && typeof window.find === 'function') { window.find(query, false, direction === 'previous', true); return; }
    show();
  };
  addEventListener('message', (event) => {
    if (parent === window || event.source !== parent || !event.data || event.data.type !== 'webcapture-find') return;
    try { search(event.data.query, event.data.direction); } catch { clear(); }
    report('webcapture-find-result', { query: String(event.data.query || '').slice(0, 200), count: state.ranges.length, index: state.index });
  });
}

export function installMobileIdentity(userAgent) {
  const define = (target, name, value) => { try { Object.defineProperty(target, name, { get: () => value, configurable: true }); } catch {} };
  if (typeof Navigator === 'undefined') return;
  define(Navigator.prototype, 'userAgent', userAgent);
  define(Navigator.prototype, 'appVersion', userAgent.replace(/^Mozilla\//, ''));
  define(Navigator.prototype, 'platform', 'Linux armv8l');
  define(Navigator.prototype, 'maxTouchPoints', 5);
}
