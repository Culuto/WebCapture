import test from 'node:test';
import assert from 'node:assert/strict';
import { charsetFromContentType, decodeStoredText, detectCharset, storedTextCharset, withCharset } from '../server/charset.mjs';

const sjisNihongo = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
const eucNihongo = Buffer.from([0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec]);

test('文字コードをヘッダー・BOM・meta・@charsetの順で判定する', () => {
  assert.equal(charsetFromContentType('text/html; charset=Shift_JIS'), 'shift_jis');
  assert.equal(charsetFromContentType('text/css; charset="EUC-JP"'), 'euc-jp');
  assert.equal(charsetFromContentType('text/html; charset=unknown-code'), null);
  assert.equal(detectCharset({ contentType: 'text/html; charset=shift_jis', body: Buffer.from('<meta charset="utf-8">') }), 'shift_jis');
  assert.equal(detectCharset({ contentType: 'text/html; charset=shift_jis', body: Buffer.from([0xef, 0xbb, 0xbf, 0x41]) }), 'utf-8');
  assert.equal(detectCharset({ contentType: 'text/html', body: Buffer.from('<html><head><meta charset="EUC-JP">') }), 'euc-jp');
  assert.equal(detectCharset({ contentType: 'text/html', body: Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">') }), 'shift_jis');
  assert.equal(detectCharset({ contentType: 'text/css', body: Buffer.from('@charset "Shift_JIS";\nbody{}') }), 'shift_jis');
  assert.equal(detectCharset({ contentType: 'text/plain', body: Buffer.from('abc') }), 'utf-8');
});

test('保存済み本文は記録した文字コード、なければ中身から読み直す', () => {
  assert.equal(decodeStoredText(sjisNihongo, { charset: 'shift_jis' }), '日本語');
  assert.equal(decodeStoredText(eucNihongo, { headers: { 'content-type': 'text/html; charset=EUC-JP' } }), '日本語');
  assert.equal(decodeStoredText(sjisNihongo, { headers: { 'content-type': 'text/css; charset=Shift_JIS' } }), '日本語');
  const transcoded = Buffer.from('日本語', 'utf8');
  assert.equal(storedTextCharset(transcoded, { headers: { 'content-type': 'text/css; charset=Shift_JIS' } }), 'utf-8');
  assert.equal(decodeStoredText(transcoded, { headers: { 'content-type': 'text/css; charset=Shift_JIS' } }), '日本語');
});

test('配信時の文字コード指定だけを差し替える', () => {
  assert.equal(withCharset('text/html; charset=Shift_JIS', 'utf-8'), 'text/html; charset=utf-8');
  assert.equal(withCharset('text/css', 'utf-8'), 'text/css; charset=utf-8');
  assert.equal(withCharset('text/html; charset=EUC-JP; foo=bar', 'utf-8'), 'text/html; foo=bar; charset=utf-8');
});
