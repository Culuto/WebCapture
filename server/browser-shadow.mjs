// ページ内で実行する関数。閉じたShadow DOMも保存できるよう、作成時に控えておきます。
export function installShadowCapture() {
  if (window.__webcaptureShadowRoots) return;
  const original = Element.prototype.attachShadow;
  if (typeof original !== 'function') return;
  const roots = new Set();
  Element.prototype.attachShadow = function attachShadow(init) {
    const root = original.call(this, init);
    try { roots.add(root); } catch {}
    return root;
  };
  Object.defineProperty(window, '__webcaptureShadowRoots', { value: roots, configurable: true });
}

// ページ内で実行する関数。入れ子のShadow DOMを内側から順に並べて返します。
export function capturedShadowRoots() {
  const roots = [];
  const seen = new Set();
  const visit = (node) => {
    for (const element of node.querySelectorAll('*')) {
      const root = element.shadowRoot;
      if (root && !seen.has(root)) { seen.add(root); roots.push(root); visit(root); }
    }
  };
  visit(document);
  for (const root of window.__webcaptureShadowRoots || []) {
    if (seen.has(root) || !root.host || !root.host.isConnected) continue;
    seen.add(root); roots.push(root); visit(root);
  }
  const depthOf = (root) => {
    let depth = 0;
    let node = root.host;
    while (node) { depth += 1; node = node.parentElement || (node.parentNode && node.parentNode.host) || null; }
    return depth;
  };
  return roots.sort((first, second) => depthOf(second) - depthOf(first));
}

// ページ内で実行する関数。JavaScriptで適用された文書全体のスタイルを文字列にします。
export function adoptedDocumentCss() {
  const blocks = [];
  for (const sheet of document.adoptedStyleSheets || []) {
    try { blocks.push([...sheet.cssRules].map((rule) => rule.cssText).join('\n')); } catch {}
  }
  return blocks.filter(Boolean).join('\n');
}
