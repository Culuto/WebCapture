import fs from 'node:fs/promises';
import path from 'node:path';
import { VaultStore } from '../server/store.mjs';

const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error('QA data path must be absolute.');
await fs.rm(target, { recursive: true, force: true });
const store = await new VaultStore(target).init();
const archiveId = 'archive_qa_demo';
const page1Url = 'https://docs.example.com/guide/';
const page2Url = 'https://docs.example.com/guide/start';
const cssUrl = 'https://docs.example.com/assets/site.css';
const html1 = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>プロダクトドキュメント</title><link rel="stylesheet" href="${cssUrl}"></head><body><header><strong>プロダクトドキュメント</strong><input placeholder="ドキュメントを検索"></header><div class="layout"><nav><b>はじめに</b><a href="${page2Url}">クイックスタート</a><span>設定</span><span>よくある質問</span></nav><main><h1>はじめに</h1><p>このドキュメントでは、プロダクトの概要と主な機能について説明します。</p><hr><button type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#more').hidden=false">主な機能を表示</button><section id="more" hidden><h2>主な機能</h2><ul><li>シンプルな操作</li><li>柔軟な設定</li><li>堅牢なエラーハンドリング</li></ul></section><h2>始めるには</h2><p><a href="${page2Url}">クイックスタートガイド</a>を参照してください。</p></main></div></body></html>`;
const html2 = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>クイックスタート</title><link rel="stylesheet" href="${cssUrl}"></head><body><header><strong>プロダクトドキュメント</strong></header><div class="layout"><nav><a href="${page1Url}">はじめに</a><b>クイックスタート</b></nav><main><h1>クイックスタート</h1><p>保存済みページ間のリンク移動を確認するためのページです。</p><a href="${page1Url}">はじめに戻る</a></main></div></body></html>`;
const css = `body{margin:0;color:#242832;font-family:"Yu Gothic UI",Meiryo,sans-serif;background:#fff}header{height:64px;border-bottom:1px solid #dfe3ea;display:flex;align-items:center;justify-content:space-between;padding:0 24px}header input{width:260px;padding:10px;border:1px solid #cfd5df}.layout{display:grid;grid-template-columns:230px 1fr;min-height:560px}nav{border-right:1px solid #e2e5eb;padding:26px 22px;display:grid;align-content:start;gap:16px}nav a{color:#0b5fff;text-decoration:none}main{padding:42px;max-width:780px}h1{font-size:30px}h2{font-size:20px;margin-top:34px}p{line-height:1.8}button{border:1px solid #bfc8d5;background:#fff;padding:10px 14px;color:#0b5fff}@media(max-width:560px){header{height:auto;min-height:54px;padding:10px 14px;gap:10px;align-items:flex-start;flex-direction:column}header input{width:100%}.layout{display:block;min-height:0}nav{border-right:0;border-bottom:1px solid #e2e5eb;padding:14px;display:flex;gap:14px;overflow:auto}main{padding:24px 18px}h1{font-size:26px}}`;
const [html1Blob, html2Blob, cssBlob] = await Promise.all([
  store.writeBlob(archiveId, html1), store.writeBlob(archiveId, html2), store.writeBlob(archiveId, css)
]);
const now = new Date().toISOString();
await store.writeManifest(archiveId, {
  schemaVersion: 1, id: archiveId, startUrl: page1Url, createdAt: now, engine: 'QA fixture', options: {}, blocked: [],
  pages: [
    { url: page1Url, requestedUrl: page1Url, title: 'はじめに', depth: 0, from: null, capturedAt: now, html: html1Blob.file, screenshot: null, resources: [cssUrl], links: [page2Url], blocked: [] },
    { url: page2Url, requestedUrl: page2Url, title: 'クイックスタート', depth: 1, from: page1Url, capturedAt: now, html: html2Blob.file, screenshot: null, resources: [cssUrl], links: [page1Url], blocked: [] }
  ],
  resources: {
    [page1Url]: { url: page1Url, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, mimeType: 'text/html; charset=utf-8', digest: html1Blob.digest, file: html1Blob.file, size: html1Blob.size, capturedAt: now },
    [page2Url]: { url: page2Url, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, mimeType: 'text/html; charset=utf-8', digest: html2Blob.digest, file: html2Blob.file, size: html2Blob.size, capturedAt: now },
    [cssUrl]: { url: cssUrl, status: 200, headers: { 'content-type': 'text/css; charset=utf-8' }, mimeType: 'text/css; charset=utf-8', digest: cssBlob.digest, file: cssBlob.file, size: cssBlob.size, capturedAt: now }
  }
});
store.state.archives = [{ id: archiveId, startUrl: page1Url, title: 'プロダクトドキュメント', status: 'complete', pages: 2, resources: 3, bytes: html1Blob.size + html2Blob.size + cssBlob.size, errors: 0, savedAt: now, engine: 'QA fixture' }];
store.state.jobs = [{
  id: 'job_qa_warning', archiveId: 'archive_qa_pending', startUrl: 'https://example.com/', status: 'warning', createdAt: now, updatedAt: now,
  pages: 126, resources: 842, bytes: 1331439862, errors: 2, depth: 5, currentUrl: 'https://assets.thirdcdn.org/img/diagram.svg',
  message: '階層の確認が必要です。', warning: { scope: 'external', threshold: 5, depth: 5, url: 'https://assets.thirdcdn.org/img/diagram.svg' },
  warningGrants: [], queue: [{ url: 'https://assets.thirdcdn.org/img/diagram.svg', depth: 5, from: 'https://example.com/docs/' }],
  visited: ['https://example.com/','https://example.com/docs/','https://cdn.example.net/styles/main.css'],
  options: { followExternal: true, respectRobots: true, captureRendered: true, maxPages: 300, maxBytes: 50 * 1024 ** 3, maxDurationMs: 43200000, sameSiteWarningDepth: 30, externalWarningDepth: 5, requestTimeoutMs: 30000, responseMaxBytes: 268435456 }
}];
await store.persist();
console.log(target);
