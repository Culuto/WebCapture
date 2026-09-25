import test from 'node:test';
import assert from 'node:assert/strict';
import { toastScript } from '../server/notify.mjs';

test('完了通知の文面はXMLとPowerShellの記号を安全に扱う', () => {
  const script = toastScript('WebCapture: 保存が完了', "a<b>&'c'");
  assert.match(script, /a&lt;b&gt;&amp;&apos;c&apos;/);
  assert.match(script, /ToastNotificationManager/);
  assert.doesNotMatch(script, /<b>/);
});
