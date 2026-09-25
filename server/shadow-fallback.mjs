export const SHADOW_TEMPLATE_ATTRIBUTE = 'data-webcapture-shadowrootmode';

export function deferSnapshotShadowRoots(tagAttributes) {
  if (!/(^|\s)shadowrootmode\s*=\s*(["']?)open\2(?=[\s>/]|$)/i.test(tagAttributes)) return tagAttributes;
  return tagAttributes.replace(/(^|\s)shadowroot(mode|delegatesfocus|clonable|serializable)(?=[\s=>/]|$)/gi, (_full, prefix, name) => `${prefix}data-webcapture-shadowroot${name.toLowerCase()}`);
}

export function installShadowFallback(immediate) {
  try {
    if (typeof document === 'undefined' || typeof Element === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    const selector = 'template[data-webcapture-shadowrootmode]';
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'shadowRoot');
    const nativeAttach = Element.prototype.attachShadow;
    if (!descriptor?.get || typeof nativeAttach !== 'function') return;
    try { window.__webcaptureRealShadowRoot = (element) => descriptor.get.call(element); } catch {}
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const pendingOf = (host) => {
      let child = host.firstElementChild;
      while (child) {
        if (child.localName === 'template' && child.hasAttribute('data-webcapture-shadowrootmode')) return child;
        if (child.localName !== 'template') return null;
        child = child.nextElementSibling;
      }
      return null;
    };
    const remember = (root) => { try { (window.__webcaptureShadowRoots ||= []).push(root); } catch {} };
    const materialize = (host, template) => {
      let root;
      try { root = nativeAttach.call(host, { mode: 'open', delegatesFocus: template.hasAttribute('data-webcapture-shadowrootdelegatesfocus') }); }
      catch { template.remove(); return descriptor.get.call(host); }
      root.append(template.content.cloneNode(true));
      template.remove();
      remember(root);
      for (const nested of root.querySelectorAll(selector)) schedule(nested, true);
      return root;
    };
    Object.defineProperty(Element.prototype, 'shadowRoot', {
      configurable: true, enumerable: descriptor.enumerable,
      get() {
        const real = descriptor.get.call(this);
        if (real) return real;
        if (this.localName.includes('-') && typeof customElements !== 'undefined' && !customElements.get(this.localName)) return null;
        const template = pendingOf(this);
        return template ? materialize(this, template) : null;
      }
    });
    Element.prototype.attachShadow = function attachShadow(init) {
      const template = pendingOf(this);
      if (template && !descriptor.get.call(this)) template.remove();
      return nativeAttach.call(this, init);
    };
    const restore = (template) => {
      const host = template.parentNode;
      if (!(host instanceof Element)) { template.remove(); return; }
      if (descriptor.get.call(host) || pendingOf(host) !== template) { template.remove(); return; }
      materialize(host, template);
    };
    const schedule = async (template, nested) => {
      const host = template.parentNode;
      if (!(host instanceof Element)) return;
      if (!immediate) {
        const tag = host.localName;
        if (tag.includes('-') && typeof customElements !== 'undefined') {
          await Promise.race([customElements.whenDefined(tag), wait(nested ? 1500 : 4000)]);
          await wait(600);
        } else await wait(nested ? 300 : 1500);
      }
      try { restore(template); } catch {}
    };
    const start = () => { try { for (const template of document.querySelectorAll(selector)) schedule(template, false); } catch {} };
    if (document.readyState === 'complete') setTimeout(start, 0);
    else if (typeof window.addEventListener === 'function') window.addEventListener('load', () => setTimeout(start, 0), { once: true });
  } catch {}
}
