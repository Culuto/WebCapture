// Executed before page scripts in the isolated capture browser.
export function installFontCapture() {
  if (!window.FontFace || window.__webcaptureFontSources) return;
  const sources = new Map();
  Object.defineProperty(window, '__webcaptureFontSources', { value: sources, configurable: true });
  window.FontFace = new Proxy(window.FontFace, {
    construct(target, args, newTarget) {
      const face = Reflect.construct(target, args, newTarget);
      const source = args[1];
      try {
        sources.set(face, typeof source === 'string' ? source :
          (ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source)).slice());
      } catch { /* An invalid source keeps the browser's native failure behavior. */ }
      return face;
    }
  });
}

// Loaded script-created fonts have no serializable source on the FontFace API.
// Keep their actual constructor bytes, not a guessed substitute URL.
export function capturedFontCss() {
  const rules = [];
  for (const [face, original] of window.__webcaptureFontSources || []) {
    if (face.status !== 'loaded' || !document.fonts.has(face)) continue;
    let source = original;
    if (typeof source !== 'string') {
      let binary = '';
      for (let offset = 0; offset < source.length; offset += 32768) binary += String.fromCharCode(...source.subarray(offset, offset + 32768));
      source = `url("data:font/otf;base64,${btoa(binary)}")`;
    } else {
      source = source.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (_full, _quote, value) => `url(${JSON.stringify(new URL(value, document.baseURI).href)})`);
    }
    const descriptors = [['style', 'font-style'], ['weight', 'font-weight'], ['stretch', 'font-stretch'], ['unicodeRange', 'unicode-range'], ['featureSettings', 'font-feature-settings'], ['variationSettings', 'font-variation-settings'], ['display', 'font-display'], ['ascentOverride', 'ascent-override'], ['descentOverride', 'descent-override'], ['lineGapOverride', 'line-gap-override'], ['sizeAdjust', 'size-adjust']];
    const family = face.family.replace(/^(['"])(.*)\1$/, '$2');
    rules.push(`@font-face{font-family:${JSON.stringify(family)};src:${source};${descriptors.filter(([property]) => face[property]).map(([property, name]) => `${name}:${face[property]};`).join('')}}`);
  }
  return { count: rules.length, css: rules.join('\n').replace(/</g, '\\3c ') };
}
