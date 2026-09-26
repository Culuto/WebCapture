import test from 'node:test';
import assert from 'node:assert/strict';
import { toastScript } from '../server/notify.mjs';

test('完了通知の文面はXMLとPowerShellの記号を安全に扱う', () => {
  const script = toastScript('WebCapture: 保存が完了', "a<b>&'c'");
  assert.match(script, /a&lt;b&gt;&amp;&apos;c&apos;/);
  assert.match(script, /ToastNotificationManager/);
  assert.doesNotMatch(script, /<b>/);
});

test('通知文面に入るページの文字は、PowerShellが引用符とみなす記号（全角の’など）も無害にする', () => {
  const script = toastScript('WebCapture: 変化がありました', "x\u2019);Start-Process calc;(\u2018 and \u201a \u201b ' end");
  const quoted = script.split('\n').find((line) => line.startsWith('$xml.LoadXml('));
  const body = quoted.slice("$xml.LoadXml('".length, -"')".length);
  assert.doesNotMatch(body.replace(/(['\u2018\u2019\u201A\u201B])\1/g, ''), /['\u2018\u2019\u201A\u201B]/, '引用符はすべて2つ重ねて文字として扱う');
});
