import { logEvent } from './logger.mjs';

const SCREENCAST_SETTINGS = Object.freeze({ format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 890, everyNthFrame: 1 });
const FRAME_INTERVAL_MS = 200;
const IDLE_LIVE = Object.freeze({ phase() {}, async pause() {}, resume() {}, stop() {} });

export async function openCaptureTarget(session) {
  if (typeof session.openPage === 'function') {
    try {
      return await session.openPage();
    } catch (error) {
      logEvent('warn', 'capture', 'browser.window.failed', { message: error.message });
    }
  }
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    session.markUnhealthy?.();
    const unavailable = new Error(`保存用のブラウザが応答しません: ${error.message}`);
    unavailable.code = 'BROWSER_UNAVAILABLE';
    throw unavailable;
  }
}

export function startLiveScreencast(client, liveView) {
  if (!liveView) return IDLE_LIVE;
  let active = false;
  let paused = false;
  let stopped = false;
  let queue = Promise.resolve();
  const sync = async () => {
    const want = !stopped && !paused && liveView.wanted();
    if (want === active) return;
    active = want;
    try {
      await client.send(want ? 'Page.startScreencast' : 'Page.stopScreencast', want ? SCREENCAST_SETTINGS : {}, 5000);
    } catch {
      active = false;
    }
  };
  const run = () => { queue = queue.then(sync); return queue; };
  const readTitle = () => client.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, 5000)
    .then((result) => { if (typeof result?.result?.value === 'string') liveView.update({ title: result.result.value }); })
    .catch(() => {});
  const removers = [
    client.on('Page.screencastFrame', ({ data, sessionId }) => {
      const interval = typeof liveView.frameIntervalMs === 'function' ? liveView.frameIntervalMs() : FRAME_INTERVAL_MS;
      setTimeout(() => client.send('Page.screencastFrameAck', { sessionId }, 5000).catch(() => {}), interval).unref?.();
      if (active && !paused && !stopped) liveView.frame(Buffer.from(data, 'base64'));
    }),
    client.on('Page.frameNavigated', ({ frame }, targetSession) => {
      if (!targetSession && !frame?.parentId && /^https?:/i.test(frame?.url || '')) liveView.update({ url: frame.url });
    }),
    client.on('Page.domContentEventFired', (_, targetSession) => { if (!targetSession) readTitle(); }),
    client.on('Page.loadEventFired', (_, targetSession) => { if (!targetSession) readTitle(); })
  ];
  const timer = setInterval(run, 1000);
  timer.unref?.();
  run();
  return {
    phase: (phase) => liveView.phase(phase),
    pause: async () => { paused = true; await run(); },
    resume: () => { paused = false; run(); },
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const remove of removers) remove();
    }
  };
}
