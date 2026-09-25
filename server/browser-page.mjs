import { CdpClient, createBrowserCaptureSession, findBrowser } from './browser-capture.mjs';

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function navigateAndSettle(client, url, { timeoutMs = 30000, settleMs = 1500 } = {}) {
  const loaded = new Promise((resolve) => {
    const remove = client.on('Page.loadEventFired', () => { remove(); resolve(true); });
    setTimeout(() => { remove(); resolve(false); }, timeoutMs).unref?.();
  });
  const navigation = await client.send('Page.navigate', { url }, timeoutMs);
  if (navigation.errorText) throw new Error(`ページを開けませんでした（${navigation.errorText}）。`);
  await loaded;
  await delay(settleMs);
}

export async function withInternetPage(task, { executable = null, policyOptions = undefined, viewportWidth = 1440, viewportHeight = 1000 } = {}) {
  const browser = executable || await findBrowser();
  if (!browser) throw Object.assign(new Error('ChromeまたはEdgeが見つかりません。'), { code: 'BROWSER_UNAVAILABLE' });
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions, viewportWidth, viewportHeight });
  let client;
  try {
    const target = await session.openPage();
    client = await new CdpClient(target.webSocketDebuggerUrl).connect();
    await Promise.all([client.send('Page.enable'), client.send('Runtime.enable')]);
    if (session.userAgent) await client.send('Network.setUserAgentOverride', { userAgent: session.userAgent, acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' }).catch(() => {});
    await client.send('Emulation.setDeviceMetricsOverride', { width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    return await task(client);
  } finally {
    client?.close();
    await session.close().catch(() => {});
  }
}

export function evaluateValue(evaluation) {
  if (evaluation?.exceptionDetails) throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text || 'ページ内の処理に失敗しました。');
  return evaluation?.result?.value;
}
