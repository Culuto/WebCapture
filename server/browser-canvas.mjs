// ページ内で実行する関数。WebGLの描画内容を画像として読み出せるようにします。
export function installCanvasPreservation() {
  if (window.__webcaptureCanvasPreserved) return;
  const original = HTMLCanvasElement.prototype.getContext;
  if (typeof original !== 'function') return;
  HTMLCanvasElement.prototype.getContext = function getContext(type, attributes) {
    if (/^(?:webgl2?|experimental-webgl)$/i.test(String(type))) attributes = { ...(attributes || {}), preserveDrawingBuffer: true };
    return original.call(this, type, attributes);
  };
  Object.defineProperty(window, '__webcaptureCanvasPreserved', { value: true, configurable: true });
}
