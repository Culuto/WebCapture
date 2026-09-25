import { WEBAUTHN_GUARD_SOURCE } from './webauthn-guard.mjs';
import { deferSnapshotShadowRoots, installShadowFallback } from './shadow-fallback.mjs';
import { installCollapseGuard, installStyleUrlRewrite } from './replay-runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeUrl, savedPageForMissingUrl } from './policy.mjs';
import { logEvent, safeUrl } from './logger.mjs';
import { parseSrcset, mapSrcset } from './srcset.mjs';
import { documentBaseUrl, IMAGE_SOURCE_ATTRIBUTES } from './asset-references.mjs';
import { isAuxiliaryRuntimeUrl, isServerBoundaryUrl } from './quality.mjs';
import { charsetFromContentType, decodeStoredText, isTextualType, storedTextCharset, withCharset } from './charset.mjs';
import { findPostResponse, findSimilarPostResponse, sortJsonKeys } from './post-archive.mjs';
import { installArchivedClock, installSeededRandom, pageSeed } from './determinism.mjs';
import { archiveIdFromReplayHost, archiveReplayHost } from '../public/replay-origin.js';

const assetAttributeNames = ['src', 'poster', 'data-src', ...IMAGE_SOURCE_ATTRIBUTES].join('|');
const quotedAssetAttributes = new RegExp(`(^|\\s)(${assetAttributeNames})\\s*=\\s*(["'])(.*?)\\3`, 'gi');
const bareAssetAttributes = new RegExp(`(^|\\s)(${assetAttributeNames})\\s*=\\s*([^\\s"'>]+)`, 'gi');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function resourceUrl(archiveId, absoluteUrl) {
  if (!absoluteUrl || /^(?:data:|blob:|javascript:|about:|#)/i.test(absoluteUrl)) return absoluteUrl;
  if (String(absoluteUrl).startsWith(`/archive/${encodeURIComponent(archiveId)}/`)) return absoluteUrl;
  const fragmentAt = absoluteUrl.indexOf('#');
  const target = fragmentAt < 0 ? absoluteUrl : absoluteUrl.slice(0, fragmentAt);
  const fragment = fragmentAt < 0 ? '' : absoluteUrl.slice(fragmentAt);
  if (/^https?:\/\/[^/?#\s"'<>]+(?:[/?]|$)/i.test(target) && !/[\s"<>\\]/.test(target)) {
    return `/archive/${encodeURIComponent(archiveId)}/web/${target}${fragment}`;
  }
  return `/archive/${encodeURIComponent(archiveId)}/resource?url=${encodeURIComponent(target)}${fragment}`;
}

export function archivedWebPath(archiveId, absoluteUrl) {
  return resourceUrl(archiveId, absoluteUrl);
}

function decodeHtmlAttribute(value) {
  return String(value).replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function resolveAsset(value, pageUrl, archiveId) {
  if (!value || /^(?:data:|blob:|javascript:|#)/i.test(value)) return value;
  if (String(value).startsWith(`/archive/${encodeURIComponent(archiveId)}/`)) return value;
  try {
    const decoded = decodeHtmlAttribute(value);
    const fragment = new URL(decoded, pageUrl).hash;
    return normalizeUrl(decoded, pageUrl) + fragment;
  } catch { return value; }
}

export function rewriteCss(css, pageUrl, archiveId) {
  return css.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (full, quote, value) => {
    const absolute = resolveAsset(value, pageUrl, archiveId);
    return absolute === value && /^(?:data:|blob:|#)/i.test(value) ? full : `url("${resourceUrl(archiveId, absolute)}")`;
  }).replace(/@import\s+(["'])([^"']+)\1/gi, (_full, quote, value) => {
    const absolute = resolveAsset(value, pageUrl, archiveId);
    return `@import ${quote}${resourceUrl(archiveId, absolute)}${quote}`;
  });
}

export function rewriteJavaScript(source, scriptUrl, archiveId) {
  const archived = (value) => {
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|\.{1,2}\/)/i.test(value)) return value;
    const absolute = resolveAsset(value, scriptUrl, archiveId);
    return /^(?:data:|blob:|javascript:|#)/i.test(absolute) ? value : resourceUrl(archiveId, absolute);
  };
  return source
    .replace(/\b((?:import|export)[^'";]*?\bfrom\s*)(["'])([^"']+)\2/g, (_full, prefix, quote, value) => `${prefix}${quote}${archived(value)}${quote}`)
    .replace(/\b(import\s*)(["'])([^"']+)\2/g, (_full, prefix, quote, value) => `${prefix}${quote}${archived(value)}${quote}`)
    .replace(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g, (_full, quote, value) => `import(${quote}${archived(value)}${quote})`)
    .replace(/new\s+URL\s*\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g, (_full, quote, value) => `new URL(${quote}${archived(value)}${quote}, location.origin)`);
}

function rewriteImportMap(source, pageUrl, archiveId) {
  try {
    const map = JSON.parse(source);
    const rewriteEntries = (entries) => Object.fromEntries(Object.entries(entries || {}).map(([key, value]) => [
      key, typeof value === 'string' ? resourceUrl(archiveId, resolveAsset(value, pageUrl, archiveId)) : value
    ]));
    map.imports = rewriteEntries(map.imports);
    if (map.scopes) {
      map.scopes = Object.fromEntries(Object.entries(map.scopes).map(([scope, entries]) => [
        resourceUrl(archiveId, resolveAsset(scope, pageUrl, archiveId)), rewriteEntries(entries)
      ]));
    }
    return JSON.stringify(map).replaceAll('<', '\\u003c');
  } catch {
    return source;
  }
}

export function upgradeLegacyMarkers(html) {
  return String(html).replace(/data-sitevault-/g, 'data-webcapture-');
}

export function rewriteHtml(html, pageUrl, archiveId, options = {}, navigationId = '', context = {}) {
  html = upgradeLegacyMarkers(html);
  const assetBaseUrl = documentBaseUrl(html, pageUrl);
  let output = html
    .replace(/\s+integrity\s*=\s*(["']).*?\1/gi, '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(["']?)(?:content-security-policy|refresh)\1[^>]*>/gi, '');
  output = output.replace(/<([a-z][a-z0-9:-]*)(\s[^<>]*?)?>/gi, (tagText, tagName, attributes = '') => {
    const lowerTag = tagName.toLowerCase();
    if (lowerTag === 'template') attributes = deferSnapshotShadowRoots(attributes);
    let rewritten = attributes.replace(quotedAssetAttributes, (_full, prefix, name, quote, value) => {
      const absolute = resolveAsset(value, assetBaseUrl, archiveId);
      return `${prefix}${name}=${quote}${resourceUrl(archiveId, absolute)}${quote}`;
    });
    rewritten = rewritten.replace(bareAssetAttributes, (_full, prefix, name, value) => {
      const absolute = resolveAsset(value, assetBaseUrl, archiveId);
      return `${prefix}${name}="${resourceUrl(archiveId, absolute)}"`;
    });
    if (!['a', 'area'].includes(lowerTag)) {
      rewritten = rewritten.replace(/\bhref\s*=\s*(["'])(.*?)\1/gi, (_full, quote, value) => {
        if (/^(?:#|javascript:|mailto:|tel:)/i.test(value)) return `href=${quote}${value}${quote}`;
        return `href=${quote}${resourceUrl(archiveId, resolveAsset(value, assetBaseUrl, archiveId))}${quote}`;
      });
    }
    if (lowerTag === 'form') rewritten = rewritten.replace(/(^|\s)action\s*=\s*(?:(["'])(.*?)\2|([^\s>]+))/gi, (_full, prefix, _quote, quoted, bare) => `${prefix}data-webcapture-action="${escapeHtml(decodeHtmlAttribute(quoted ?? bare))}" action="#"`);
    rewritten = rewritten.replace(/\b(srcset|data-srcset|imagesrcset)\s*=\s*(["'])([\s\S]*?)\2/gi, (_full, name, quote, value) => `${name}=${quote}${mapSrcset(value, url => resourceUrl(archiveId, resolveAsset(url, assetBaseUrl, archiveId)))}${quote}`);
    rewritten = rewritten.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (_full, quote, value) => `style=${quote}${rewriteCss(value, assetBaseUrl, archiveId)}${quote}`);
    return `<${tagName}${rewritten}>`;
  });
  output = output.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_full, attributes, css) => `<style${attributes}>${rewriteCss(css, assetBaseUrl, archiveId)}</style>`);
  output = output.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attributes, source) => {
    if (/\bsrc\s*=/i.test(attributes) || !source.trim()) return full;
    const type = attributes.match(/\btype\s*=\s*(["'])(.*?)\1/i)?.[2]?.toLowerCase();
    if (type === 'importmap') return `<script${attributes}>${rewriteImportMap(source, assetBaseUrl, archiveId)}</script>`;
    if (type && !/^(?:module|text\/javascript|application\/(?:javascript|ecmascript))$/.test(type)) return full;
    return `<script${attributes}>${rewriteJavaScript(source, assetBaseUrl, archiveId)}</script>`;
  });
  const scriptless = Boolean(context.light || context.still);
  if (scriptless) output = lightweightHtml(output, { pauseMotion: Boolean(context.light) });
  const collapseGuard = context.guard && !scriptless ? `(${installCollapseGuard.toString()})(archivePrefix+'page?url='+encodeURIComponent(pageUrl)+(navigationId?'&navigationId='+encodeURIComponent(navigationId):'')+'&mode=static',report);` : '';
  const determinism = WEBAUTHN_GUARD_SOURCE + `(${installShadowFallback.toString()})(${scriptless});` + (context.seedUrl ? `(${installSeededRandom.toString()})(${pageSeed(context.seedUrl)});` : '') + (Number.isFinite(Date.parse(context.capturedAt || '')) ? `(${installArchivedClock.toString()})(${Date.parse(context.capturedAt)});` : '');
  const bridge = `<script>${determinism}(function(){
    const pageUrl=${JSON.stringify(pageUrl)},baseUrl=${JSON.stringify(assetBaseUrl)},archiveId=${JSON.stringify(archiveId)},navigationId=${JSON.stringify(navigationId)};
    const parseSrcset=${parseSrcset.toString()};
    const freezeImages=${options.freezeResponsiveImages === true};
    const unarchive=resolved=>{const prefix='/archive/'+encodeURIComponent(archiveId)+'/';if(!resolved.pathname.startsWith(prefix))return null;const rest=resolved.pathname.slice(prefix.length);if(rest.startsWith('web/'))return rest.slice(4).replace(/^(https?):[/]+/i,'$1://')+resolved.search+resolved.hash;if(rest==='resource'||rest==='page')return resolved.searchParams.get('url');return null};
    const absolute=u=>{const resolved=new URL(typeof u==='string'?u:(u&&u.url)||String(u||''),baseUrl);if(resolved.origin!==location.origin){const original=unarchive(resolved);if(original)return original}if(resolved.origin===location.origin&&!resolved.pathname.startsWith('/archive/'+encodeURIComponent(archiveId)+'/'))return new URL(resolved.pathname+resolved.search+resolved.hash,new URL(pageUrl).origin).href;return resolved.href};
    const archivePrefix='/archive/'+encodeURIComponent(archiveId)+'/';
    const archived=target=>{const hashAt=target.indexOf('#'),base=hashAt<0?target:target.slice(0,hashAt),hash=hashAt<0?'':target.slice(hashAt);return /^https?:[/][/][^/?#"'<>\\s]+(?:[/?]|$)/i.test(base)&&!/[\\s"<>\\\\]/.test(base)?archivePrefix+'web/'+base+hash:archivePrefix+'resource?url='+encodeURIComponent(base)+hash};
    const saved=u=>{const value=typeof u==='string'?u:(u&&u.url)||String(u||'');if(/^(?:data:|blob:|about:|#)/i.test(value))return value;try{const resolved=new URL(value,location.href);if(resolved.origin===location.origin&&resolved.pathname.startsWith(archivePrefix))return resolved.href}catch{}return archived(absolute(value))};
    const report=(type,data={})=>{try{parent.postMessage({type,archiveId,pageUrl,navigationId,...data},'*')}catch{}};
    (${installStyleUrlRewrite.toString()})(saved);
    ${collapseGuard}
    const nativeAttachShadow=Element.prototype.attachShadow;
    if(nativeAttachShadow)Element.prototype.attachShadow=function(init){return (typeof window.__webcaptureRealShadowRoot==='function'?window.__webcaptureRealShadowRoot(this):this.shadowRoot)||nativeAttachShadow.call(this,init)};
    const nativeFetch=window.fetch&&window.fetch.bind(window);
    const sortJsonKeys=${sortJsonKeys.toString()};
    const hex=buffer=>[...new Uint8Array(buffer)].map(value=>value.toString(16).padStart(2,'0')).join('');
    const bodyBytes=async body=>{if(body==null)return new Uint8Array();if(typeof body==='string')return new TextEncoder().encode(body);if(body instanceof URLSearchParams)return new TextEncoder().encode(body.toString());if(body instanceof Blob)return new Uint8Array(await body.arrayBuffer());if(body instanceof ArrayBuffer)return new Uint8Array(body);if(ArrayBuffer.isView(body))return new Uint8Array(body.buffer,body.byteOffset,body.byteLength);if(body instanceof FormData){const params=new URLSearchParams();body.forEach((value,key)=>params.append(key,typeof value==='string'?value:value.name||''));return new TextEncoder().encode(params.toString())}return new TextEncoder().encode(String(body))};
    const digestOf=async bytes=>window.crypto&&crypto.subtle?hex(await crypto.subtle.digest('SHA-256',bytes)):'';
    const postUrl=(url,digest='',canonical='')=>'/archive/'+encodeURIComponent(archiveId)+'/post?url='+encodeURIComponent(absolute(url))+'&digest='+digest+'&canonical='+canonical;
    const postLookup=async(url,body)=>{const bytes=await bodyBytes(body);const digest=await digestOf(bytes).catch(()=>'');let canonical='';try{canonical=await digestOf(new TextEncoder().encode(JSON.stringify(sortJsonKeys(JSON.parse(new TextDecoder().decode(bytes))))))}catch{}return {url:postUrl(url,digest,canonical),bytes}};
    if(nativeFetch)window.fetch=async(input,init={})=>{const method=String(init.method||(input&&input.method)||'GET').toUpperCase();if(method==='POST'){const url=typeof input==='string'||input instanceof URL?String(input):input.url;const body=init.body!==undefined?init.body:(input instanceof Request?await input.clone().arrayBuffer():null);let requestType='';try{requestType=new Headers(init.headers||(input instanceof Request?input.headers:undefined)).get('content-type')||''}catch{}const lookup=await postLookup(url,body);const response=await nativeFetch(lookup.url,{method:'POST',body:lookup.bytes,headers:{'content-type':'application/octet-stream','x-webcapture-request-type':requestType.slice(0,200),'x-webcapture-page':encodeURIComponent((()=>{try{return currentOriginal().href}catch{return pageUrl}})())},credentials:'omit',signal:init.signal||(input instanceof Request?input.signal:undefined)});report(response.headers.get('x-webcapture-missing-resource')?'webcapture-missing':'webcapture-post',{kind:'post',transport:'fetch'});return response}if(!['GET','HEAD'].includes(method)){report('webcapture-blocked',{reason:'request',transport:'fetch',method});return new Response(null,{status:204,statusText:'Archived request blocked'})}const request=input instanceof Request?{headers:input.headers,signal:input.signal,cache:input.cache}:{};const response=await nativeFetch(saved(input),{...request,...init,method,credentials:'omit'});if(response.headers.get('x-webcapture-missing-resource'))report('webcapture-missing',{kind:'fetch'});return response};
    if(window.XMLHttpRequest){const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...rest){const normalizedMethod=String(method).toUpperCase(),safe=['GET','HEAD'].includes(normalizedMethod);this.__webcapturePost=normalizedMethod==='POST'?{url,async:rest[0]!==false}:null;this.__webcaptureBlocked=!safe&&!this.__webcapturePost;if(this.__webcaptureBlocked)report('webcapture-blocked',{reason:'request',transport:'xhr',method:normalizedMethod});return open.call(this,safe?method:'GET',safe?saved(url):'data:text/plain,',...rest)};const send=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(body){const post=this.__webcapturePost;if(post){this.__webcapturePost=null;if(!post.async){open.call(this,'GET',postUrl(post.url),false);return send.call(this,null)}const xhr=this;postLookup(post.url,body).then(lookup=>{open.call(xhr,'POST',lookup.url,true);send.call(xhr,lookup.bytes);report('webcapture-post',{kind:'post',transport:'xhr'})}).catch(()=>{open.call(xhr,'GET',postUrl(post.url),true);send.call(xhr,null)});return}return send.call(this,this.__webcaptureBlocked?null:body)};}
    if(window.navigator&&window.navigator.sendBeacon)window.navigator.sendBeacon=()=>{report('webcapture-blocked',{reason:'request',transport:'beacon',method:'POST'});return true};
    const move=(u,source='script')=>{let target;try{target=absolute(u)}catch{return}if(!/^https?:/i.test(target))return;report('webcapture-navigate',{url:target,source})};
    document.addEventListener('submit',e=>{const form=e.target,method=String(form.method||'get').toUpperCase();if(method==='GET'){e.preventDefault();const url=new URL(form.getAttribute('data-webcapture-action')||form.getAttribute('action')||pageUrl,baseUrl);new FormData(form).forEach((value,key)=>url.searchParams.append(key,String(value)));move(url.href,'form')}else{e.preventDefault();report('webcapture-blocked',{reason:'form',transport:'form',method})}},true);
    document.addEventListener('click',e=>{const a=(typeof e.composedPath==='function'?e.composedPath():[e.target]).find(n=>n&&n.matches&&n.matches('a[href],area[href]'))||(e.target.closest&&e.target.closest('a[href],area[href]'));if(!a||e.defaultPrevented)return;const raw=a.getAttribute('href');if(!raw||raw.startsWith('#')||raw.startsWith('javascript:'))return;e.preventDefault();move(raw,'click')},false);
    const originalLocation=new URL(pageUrl);
    const currentOriginal=()=>new URL(String(location.pathname||'/')+String(location.search||'')+String(location.hash||''),originalLocation.origin);
    const nativeHistory={pushState:history.pushState,replaceState:history.replaceState};
    if(String(location.pathname||'').startsWith('/archive/')){try{nativeHistory.replaceState.call(history,history.state,'',originalLocation.pathname+originalLocation.search+String(location.hash||''))}catch{}}
    ['pushState','replaceState'].forEach(name=>{const original=nativeHistory[name];history[name]=function(state,title,url){if(url===undefined||url===null)return original.call(this,state,title);let target;try{target=new URL(String(url),currentOriginal())}catch{return original.call(this,state,title)}const result=original.call(this,state,title,target.pathname+target.search+target.hash);report('webcapture-location',{url:target.href});return result}});
    if(window.navigation&&typeof navigation.addEventListener==='function')navigation.addEventListener('navigate',event=>{try{if(event.destination.sameDocument||event.hashChange||event.downloadRequest||!event.cancelable||event.navigationType==='reload')return;const destination=new URL(event.destination.url);if(destination.origin===location.origin&&destination.pathname.startsWith('/archive/'))return;event.preventDefault();move(destination.origin===location.origin?new URL(destination.pathname+destination.search+destination.hash,originalLocation.origin).href:destination.href,event.userInitiated?'click':'script')}catch{}});
    window.open=u=>{move(u);return null};
    if(window.Worker){const NativeWorker=window.Worker;window.Worker=function(url,options){return new NativeWorker(saved(url),options)};window.Worker.prototype=NativeWorker.prototype;}
    if(window.FontFace){const NativeFontFace=window.FontFace;const fontUrl=/url[(][ \\t]*(["']?)([^)"']+)[\\x22\\x27]?[ \\t]*[)]/gi;window.FontFace=function(family,source,descriptors){if(typeof source==='string')source=source.replace(fontUrl,(match,quote,value)=>/^(?:data:|blob:)/i.test(value)?match:'url("'+saved(value)+'")');return new NativeFontFace(family,source,descriptors)};window.FontFace.prototype=NativeFontFace.prototype;}
    const resourceAttributes=new Set(['src','poster','data-src','data-srcset','srcset','imagesrcset',...${JSON.stringify(IMAGE_SOURCE_ATTRIBUTES)}]);
    const nativeSet=Element.prototype.setAttribute;
    const mapSet=(element,name,value)=>{const key=String(name).toLowerCase();if(freezeImages&&element.tagName==='IMG'&&element.getAttribute('data-webcapture-current-src')){if(key.endsWith('srcset'))return '';if(['src','data-src'].includes(key))return saved(element.getAttribute('data-webcapture-current-src'))}if(key==='href'&&!['A','AREA','BASE'].includes(element.tagName)||resourceAttributes.has(key)){if(key.endsWith('srcset'))return parseSrcset(value).map(({url,descriptor})=>saved(url)+(descriptor?' '+descriptor:'')).join(', ');return saved(value)}return value};
    Element.prototype.setAttribute=function(name,value){return nativeSet.call(this,name,mapSet(this,name,value))};
    for(const [Constructor,names] of [[window.HTMLImageElement,['src','srcset']],[window.HTMLScriptElement,['src']],[window.HTMLLinkElement,['href','imageSrcset']],[window.HTMLMediaElement,['src','poster']],[window.HTMLSourceElement,['src','srcset']],[window.HTMLIFrameElement,['src']]]){
      if(!Constructor)continue;for(const name of names){const descriptor=Object.getOwnPropertyDescriptor(Constructor.prototype,name);if(!descriptor?.set)continue;Object.defineProperty(Constructor.prototype,name,{...descriptor,set(value){descriptor.set.call(this,mapSet(this,name,value))}})}
    }
    document.addEventListener('error',event=>{if(event.target!==window&&event.target?.tagName)report('webcapture-missing',{kind:event.target.tagName.toLowerCase()})},true);
    document.fonts?.addEventListener('loadingerror',()=>report('webcapture-missing',{kind:'font'}));
    addEventListener('error',event=>report('webcapture-runtime-error',{message:String(event.message||'Script error').slice(0,500)}));
    addEventListener('unhandledrejection',event=>report('webcapture-runtime-error',{message:String(event.reason?.message||'Promise rejected').slice(0,500)}));
    addEventListener('load',()=>report('webcapture-ready'),{once:true});
    addEventListener('DOMContentLoaded',()=>document.querySelectorAll('canvas[data-webcapture-canvas]').forEach(canvas=>{const image=new Image();image.onload=()=>canvas.getContext('2d')?.drawImage(image,0,0,canvas.width,canvas.height);image.src=canvas.dataset.webcaptureCanvas}),{once:true});
    if(typeof performance!=='undefined'&&typeof setInterval==='function')(()=>{let longMs=0,last=performance.now(),samples=[],warned=false;try{new PerformanceObserver(list=>{for(const entry of list.getEntries())longMs+=entry.duration}).observe({type:'longtask',buffered:false})}catch{}setInterval(()=>{const now=performance.now(),lag=Math.max(0,now-last-1000);last=now;samples.push(Math.min(1,(lag+longMs)/1000));longMs=0;if(samples.length>10)samples.shift();const busy=samples.reduce((sum,value)=>sum+value,0)/samples.length;const memory=performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null;report('webcapture-heartbeat',{busy:Math.round(busy*100),memory});if(!warned&&samples.length>=8&&(busy>0.7||(memory&&memory>1500))){warned=true;report('webcapture-heavy',{busy:Math.round(busy*100),memory})}},1000)})();
  })();</script>`;
  const metadata = `<meta name="webcapture-archived-url" content="${escapeHtml(pageUrl)}">`;
  if (/<head\b[^>]*>/i.test(output)) output = output.replace(/<head\b[^>]*>/i, (match) => `${match}${metadata}${bridge}`);
  else output = `<!doctype html><html><head>${metadata}${bridge}</head><body>${output}</body></html>`;
  return output;
}

const REQUEST_BODY_LIMIT = 1024 * 1024;

function readLookupBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => { size += chunk.length; if (size <= REQUEST_BODY_LIMIT) chunks.push(chunk); });
    req.on('end', () => resolve(size <= REQUEST_BODY_LIMIT ? Buffer.concat(chunks) : null));
    req.on('error', () => resolve(null));
  });
}

const requestBodyCache = new Map();
const rewriteCache = new Map();
const REWRITE_CACHE_BYTES = 256 * 1024 * 1024;
let rewriteCacheBytes = 0;

function rememberRewrite(tag, body) {
  if (body.length > 32 * 1024 * 1024) return;
  if (rewriteCache.has(tag)) return;
  rewriteCache.set(tag, body);
  rewriteCacheBytes += body.length;
  while (rewriteCacheBytes > REWRITE_CACHE_BYTES && rewriteCache.size) {
    const [oldest, value] = rewriteCache.entries().next().value;
    rewriteCache.delete(oldest);
    rewriteCacheBytes -= value.length;
  }
}

export function replayCacheTag(config, resource, light = false) {
  const digest = String(resource?.digest || '').replace(/[^a-z0-9]/gi, '').slice(-40);
  if (!digest || Number(resource.status || 200) !== 200) return null;
  return `"sv-${String(config?.version || 'dev').replace(/[^0-9a-z.]/gi, '')}-${digest}-${light ? 'l' : 'n'}"`;
}

async function readArchiveFile(store, archiveId, file) {
  const key = `${archiveId}:${file}`;
  if (requestBodyCache.has(key)) return requestBodyCache.get(key);
  const body = await fs.readFile(path.join(store.archiveRoot(archiveId), file));
  requestBodyCache.set(key, body);
  if (requestBodyCache.size > 3000) requestBodyCache.delete(requestBodyCache.keys().next().value);
  return body;
}

const WARMUP_ITEM_LIMIT = 6000;
const WARMUP_BYTES_LIMIT = 400 * 1024 * 1024;
const WARMUP_ITEM_BYTES_LIMIT = 8 * 1024 * 1024;

export function warmupList(manifest, archiveId, startUrl = '') {
  const pages = manifest.pages || [];
  const first = pages.find((page) => page.url === startUrl || page.requestedUrl === startUrl);
  const ordered = first ? [first, ...pages.filter((page) => page !== first)] : pages;
  const seen = new Set();
  const urls = [];
  let bytes = 0;
  for (const page of ordered) {
    for (const url of page.resources || []) {
      if (seen.has(url) || url === page.url) continue;
      seen.add(url);
      const resource = manifest.resources?.[url] || manifest.resources?.[manifest.resourceAliases?.[url]];
      if (!resource?.file || Number(resource.status || 200) !== 200 || !resource.digest) continue;
      const type = String(resource.mimeType || resource.headers?.['content-type'] || '');
      if (/^(?:video|audio)\//i.test(type) || Number(resource.size || 0) > WARMUP_ITEM_BYTES_LIMIT) continue;
      if (bytes + Number(resource.size || 0) > WARMUP_BYTES_LIMIT || urls.length >= WARMUP_ITEM_LIMIT) return { urls, bytes, truncated: true };
      bytes += Number(resource.size || 0);
      urls.push(resourceUrl(archiveId, url));
    }
  }
  return { urls, bytes, truncated: false };
}

function warmupHtml(archiveId, startUrl) {
  const listUrl = `/archive/${encodeURIComponent(archiveId)}/warm-list?url=${encodeURIComponent(startUrl)}`;
  return `<!doctype html><meta charset="utf-8"><title>warmup</title><script>(${runWarmup.toString()})(${JSON.stringify(listUrl)});</script>`;
}

export function runWarmup(listUrl) {
  let paused = false;
  let stopped = false;
  const resumeWaiters = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const whenRunning = () => paused ? new Promise((resolve) => resumeWaiters.push(resolve)) : Promise.resolve();
  addEventListener('message', (event) => {
    if (event.source !== parent) return;
    if (event.data?.type === 'webcapture-warm-pause') paused = true;
    if (event.data?.type === 'webcapture-warm-resume') { paused = false; resumeWaiters.splice(0).forEach((resolve) => resolve()); }
    if (event.data?.type === 'webcapture-warm-stop') { stopped = true; paused = false; resumeWaiters.splice(0).forEach((resolve) => resolve()); }
  });
  const report = (data) => { try { parent.postMessage({ type: 'webcapture-warm-progress', ...data }, '*'); } catch {} };
  (async () => {
    let list;
    try { list = await (await fetch(listUrl, { credentials: 'omit' })).json(); } catch { return; }
    const urls = list.urls || [];
    let cursor = 0;
    let done = 0;
    const worker = async () => {
      while (!stopped && cursor < urls.length) {
        await whenRunning();
        if (stopped) return;
        const url = urls[cursor++];
        try { const response = await fetch(url, { credentials: 'omit', priority: 'low' }); await response.arrayBuffer(); } catch {}
        done += 1;
        if (done % 25 === 0 || done === urls.length) report({ done, total: urls.length });
        await wait(30);
      }
    };
    await Promise.all([worker(), worker()]);
  })();
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const LIGHT_STYLE = '<style data-webcapture-light>*,*::before,*::after{animation-play-state:paused!important;transition:none!important;scroll-behavior:auto!important}</style>';

export function lightweightHtml(html, { pauseMotion = true } = {}) {
  let output = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
  let previous;
  do {
    previous = output;
    output = output.replace(/(<[a-z][a-z0-9:-]*\b[^<>]*?)\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
  } while (output !== previous);
  if (!pauseMotion) return output.replace(/\bhref\s*=\s*(["'])\s*javascript:[^"']*\1/gi, 'href="#"');
  output = output.replace(/(<(?:video|audio)\b[^>]*?)\s+autoplay(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '$1');
  output = output.replace(/\bhref\s*=\s*(["'])\s*javascript:[^"']*\1/gi, 'href="#"');
  return /<\/head>/i.test(output) ? output.replace(/<\/head>/i, `${LIGHT_STYLE}</head>`) : LIGHT_STYLE + output;
}

function readableBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function replayFileHtml({ archiveId, pageUrl, navigationId = '', resource = null, title = '', pending = false }) {
  const name = (() => { try { return decodeURIComponent(new URL(pageUrl).pathname.split('/').filter(Boolean).pop() || pageUrl); } catch { return pageUrl; } })();
  const source = resource ? resourceUrl(archiveId, pageUrl) : '';
  const type = String(resource?.mimeType || resource?.headers?.['content-type'] || '').toLowerCase();
  const ready = JSON.stringify({ type: 'webcapture-ready', archiveId, pageUrl, navigationId }).replaceAll('<', '\\u003c');
  const open = JSON.stringify({ type: 'webcapture-open-file', archiveId, pageUrl, navigationId, path: source }).replaceAll('<', '\\u003c');
  let preview = '';
  if (resource && type.startsWith('image/')) preview = `<img src="${escapeHtml(source)}" alt="">`;
  else if (resource && type.startsWith('video/')) preview = `<video src="${escapeHtml(source)}" controls></video>`;
  else if (resource && type.startsWith('audio/')) preview = `<audio src="${escapeHtml(source)}" controls></audio>`;
  const detail = resource
    ? `${escapeHtml(type.split(';')[0] || 'ファイル')}・${readableBytes(resource.size)}`
    : pending ? '容量の上限を超えたため未保存。アーカイブ画面から保存できます。' : '保存されていないファイル。';
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title || name)}</title><style>body{font-family:system-ui,sans-serif;margin:0;padding:40px;color:#1f2430;background:#f6f7f9}main{max-width:900px;margin:auto;background:#fff;border:1px solid #e3e6eb;border-radius:10px;padding:28px}h1{font-size:18px;margin:0 0 6px;overflow-wrap:anywhere}p{margin:0 0 18px;color:#5c6472}img,video{max-width:100%;border-radius:6px;background:#000}audio{width:100%}button{font:inherit;border:0;border-radius:6px;background:#0b5fff;color:#fff;padding:9px 16px;cursor:pointer}</style><main><h1>${escapeHtml(name)}</h1><p>${detail}</p>${preview}${resource ? `<p style="margin-top:18px"><button type="button" id="open">別のタブで開く</button></p>` : ''}</main><script>parent.postMessage(${ready},'*');document.getElementById('open')?.addEventListener('click',()=>parent.postMessage(${open},'*'))</script>`;
}

function replayFailureHtml(title, detail, archiveId, pageUrl, navigationId = '') {
  const message = JSON.stringify({ type: 'webcapture-page-error', archiveId, pageUrl, navigationId, message: title }).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;margin:48px;color:#242832}h1{font-size:22px}p{color:#5c6472;overflow-wrap:anywhere}</style><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><script>parent.postMessage(${message},'*')</script>`;
}

export function byteRange(value, size) {
  const match = String(value || '').match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || !match[1] && !match[2]) return null;
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !size || !match[1] && Number(match[2]) === 0 || start >= size || end < start) return { unsatisfiable: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

const VOLATILE_QUERY_KEY = /^(?:_|t|ts|_t|_ts|v|ver|version|cb|cachebust(?:er)?|bust|rand(?:om)?|r|nocache|timestamp|time|nonce|hash|rev|build|seed|_dc)$/i;
const queryVariantIndexes = new WeakMap();

function volatileQueryParam(key, value) {
  return VOLATILE_QUERY_KEY.test(key) || /^\d{8,}$/.test(value) || /^[a-f0-9]{16,}$/i.test(value)
    || /^0?\.\d{6,}$/.test(value) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
}

function stableQuery(url) {
  return [...url.searchParams.entries()].filter(([key, value]) => !volatileQueryParam(key, value)).sort(([a], [b]) => a.localeCompare(b));
}

export function findQueryVariantFallback(manifest, target) {
  let wanted;
  try { wanted = new URL(target); } catch { return null; }
  if (!wanted.search) return null;
  let index = queryVariantIndexes.get(manifest);
  if (!index) {
    index = new Map();
    for (const resource of Object.values(manifest.resources || {})) {
      if (!(Number(resource.status) < 400) || !(resource.size > 0)) continue;
      try {
        const url = new URL(resource.url);
        const key = `${url.origin}${url.pathname}`;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({ resource, stable: JSON.stringify(stableQuery(url)) });
      } catch {}
    }
    queryVariantIndexes.set(manifest, index);
  }
  const stable = JSON.stringify(stableQuery(wanted));
  const match = (index.get(`${wanted.origin}${wanted.pathname}`) || []).find((candidate) => candidate.stable === stable);
  return match ? { kind: 'query-variant', resource: match.resource } : null;
}

export function findTypekitCompleteFontFallback(manifest, target) {
  try {
    const requested = new URL(target);
    if (requested.hostname !== 'use.typekit.net' || !requested.pathname.startsWith('/af/')) return null;
    for (const [url, resource] of Object.entries(manifest.resources || {})) {
      const candidate = new URL(url);
      if (candidate.origin === requested.origin && candidate.pathname === requested.pathname
        && candidate.searchParams.get('chunks') === '0' && Number(resource?.status || 0) === 200) {
        return { url, resource, kind: 'complete-font' };
      }
    }
  } catch {}
  return null;
}

const auxiliaryPixelGif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const auxiliaryNoopScript = Buffer.from(`/* WebCapture: analytics disabled during offline replay. */
(() => {
  const noop = () => true;
  globalThis.webPixelsManager = {
    init: () => ({ publish: noop, publishCustomEvent: noop, visitor: async () => null }),
    createShopifyExtend: () => ({ extend: noop })
  };
})();
`);
const auxiliaryNoopDocument = Buffer.from('<!doctype html><meta charset="utf-8"><title></title>');
const serverBoundaryNoopScript = Buffer.from('/* WebCapture: external account or payment service unavailable during offline replay. */\n');
const serverBoundaryNoopDocument = Buffer.from('<!doctype html><meta charset="utf-8"><title></title>');
const serverBoundaryNoopJson = Buffer.from('{}');

export function auxiliaryReplayResponse(target, resource = null) {
  if (!isAuxiliaryRuntimeUrl(target)) return null;
  try {
    const url = new URL(target);
    const type = String(resource?.mimeType || resource?.headers?.['content-type'] || '').toLowerCase();
    if (url.hostname === 'p.typekit.net' && url.pathname === '/p.gif') {
      return { contentType: 'image/gif', body: auxiliaryPixelGif };
    }
    if (/\/cdn\/wpm\//i.test(url.pathname) || /javascript|ecmascript/.test(type) || /(?:worker|\.m?js)(?:$|\/)/i.test(url.pathname)) {
      return { contentType: 'text/javascript; charset=utf-8', body: auxiliaryNoopScript };
    }
    return { contentType: 'text/html; charset=utf-8', body: auxiliaryNoopDocument };
  } catch {
    return null;
  }
}

export function serverBoundaryReplayResponse(target) {
  if (!isServerBoundaryUrl(target)) return null;
  try {
    const url = new URL(target);
    if (/\.m?js$/i.test(url.pathname)) return { contentType: 'text/javascript; charset=utf-8', body: serverBoundaryNoopScript };
    if (/\/pay\/session(?:\/|$)/i.test(url.pathname)) return { contentType: 'application/json; charset=utf-8', body: serverBoundaryNoopJson };
    return { contentType: 'text/html; charset=utf-8', body: serverBoundaryNoopDocument };
  } catch {
    return null;
  }
}

export function replayDocumentCsp(config) {
  const ancestors = ["'self'", `http://${config.host}:${config.port}`, `http://localhost:${config.port}`, ...(config.iframeParentOrigins || [])];
  return `default-src 'self' data: blob:; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'none'; object-src 'none'; frame-src 'self'; child-src 'self'; form-action 'self'; frame-ancestors ${[...new Set(ancestors)].join(' ')}`;
}

const REPLAY_COOKIE = 'webcapture_replay';

function replayCookie(archiveId, pageUrl) {
  const page = new URL(pageUrl);
  page.hash = '';
  return `${REPLAY_COOKIE}=${encodeURIComponent(archiveId)}~${Buffer.from(page.href).toString('base64url')}; Path=/; HttpOnly; SameSite=Lax`;
}

function currentReplayPage(req, lastPages) {
  const fromCookie = replayCookieTarget(req);
  if (fromCookie) return fromCookie;
  const hostArchive = archiveIdFromReplayHost(String(req.headers.host || '').split(':')[0]);
  const pageUrl = hostArchive ? lastPages.get(hostArchive) : null;
  if (!pageUrl) return null;
  try { return { archiveId: hostArchive, origin: new URL(pageUrl).origin, pageUrl }; } catch { return null; }
}

function replayCookieTarget(req) {
  const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${REPLAY_COOKIE}=`));
  if (!cookie) return null;
  const [archiveId, encodedOrigin] = decodeURIComponent(cookie.slice(REPLAY_COOKIE.length + 1)).split('~');
  if (!/^archive_[a-z0-9_]+$/i.test(archiveId || '')) return null;
  try {
    const page = new URL(Buffer.from(encodedOrigin || '', 'base64url').toString('utf8'));
    return /^https?:$/.test(page.protocol) ? { archiveId, origin: page.origin, pageUrl: page.href } : null;
  } catch { return null; }
}

export function createReplayHandler(store, config) {
  const lastPages = new Map();
  const lightArchives = new Set();
  return async function replayHandler(req, res) {
    const host = String(req.headers.host || '').toLowerCase();
    const [hostname, hostPort] = host.split(':');
    const hostArchive = hostPort === String(config.replayPort) ? archiveIdFromReplayHost(hostname) : null;
    if (!hostArchive && host !== `${config.host}:${config.replayPort}` && host !== `localhost:${config.replayPort}`) {
      return send(res, 400, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }, 'Invalid Host');
    }
    const postLookupRequest = req.method === 'POST' && /^\/archive\/[^/]+\/post(?:\?|$)/.test(String(req.url || ''));
    if (!['GET', 'HEAD'].includes(req.method) && !postLookupRequest) {
      return send(res, 405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD', 'x-content-type-options': 'nosniff' }, 'Method not allowed');
    }
    const requestUrl = new URL(req.url, `http://${config.host}:${config.replayPort}`);
    const webMatch = requestUrl.pathname.match(/^\/archive\/([^/]+)\/web\/(https?:\/+.+)$/i);
    const match = webMatch ? [webMatch[0], webMatch[1], 'resource'] : requestUrl.pathname.match(/^\/archive\/([^/]+)\/(page|resource|post|warm|warm-list)$/);
    if (!match) {
      const remembered = currentReplayPage(req, lastPages);
      if (remembered && !requestUrl.pathname.startsWith('/archive/') && requestUrl.pathname !== '/favicon.ico') {
        const original = `${remembered.origin}${requestUrl.pathname}${requestUrl.search}`;
        const destination = String(req.headers['sec-fetch-dest'] || '');
        const kind = ['document', 'iframe', 'frame', ''].includes(destination) ? 'page' : 'resource';
        logEvent('info', 'replay', 'path.remapped', { archiveId: remembered.archiveId, url: safeUrl(original), kind, destination: destination || 'unknown' });
        return send(res, 302, {
          location: kind === 'page'
            ? `/archive/${encodeURIComponent(remembered.archiveId)}/page?url=${encodeURIComponent(original)}`
            : resourceUrl(remembered.archiveId, original),
          'cache-control': 'no-store', 'content-length': 0
        }, null);
      }
      return send(res, 404, { 'content-type': 'text/plain; charset=utf-8' }, 'Not found');
    }
    let archiveId;
    try { archiveId = decodeURIComponent(match[1]); } catch {
      return send(res, 400, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }, 'Invalid archive ID');
    }
    if (!/^archive_[a-z0-9_]+$/i.test(archiveId)) return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Invalid archive ID');
    if (hostArchive && hostArchive !== archiveId) return send(res, 403, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }, 'Archive mismatch');
    const manifest = await store.readManifest(archiveId);
    if (!manifest) return send(res, 404, { 'content-type': 'text/html; charset=utf-8' }, '<h1>アーカイブが見つかりません</h1>');
    const inputUrl = webMatch
      ? `${webMatch[2].replace(/^(https?):\/+/i, '$1://')}${requestUrl.search}`
      : requestUrl.searchParams.get('url') || manifest.startUrl;
    const mode = requestUrl.searchParams.get('mode');
    const light = mode === 'light';
    const still = mode === 'static';
    const modeQuery = light ? '&mode=light' : still ? '&mode=static' : '';
    const navigationIdInput = requestUrl.searchParams.get('navigationId') || '';
    const navigationId = /^[a-z0-9_-]{1,80}$/i.test(navigationIdInput) ? navigationIdInput : '';
    let target;
    try { target = normalizeUrl(inputUrl); } catch { return send(res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Invalid URL'); }
    const commonHeaders = {
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'cross-origin',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    };
    if (match[2] === 'warm') {
      return send(res, 200, { ...commonHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': replayDocumentCsp(config) }, warmupHtml(archiveId, target));
    }
    if (match[2] === 'warm-list') {
      const list = warmupList(manifest, archiveId, target);
      return send(res, 200, { ...commonHeaders, 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(list));
    }
    if (match[2] === 'page') {
      const page = manifest.pages.find((item) => item.url === target || item.requestedUrl === target);
      const fileResource = page?.file
        ? manifest.resources[page.url] || manifest.resources[manifest.resourceAliases?.[page.url]]
        : !page ? (manifest.resources[target] || manifest.resources[manifest.resourceAliases?.[target]]) : null;
      if ((page?.file || !page) && (fileResource || page?.file)) {
        const pending = (manifest.deferredMedia || []).some((item) => item.url === (page?.url || target));
        logEvent('info', 'replay', 'file.page.served', { archiveId, pageUrl: safeUrl(target), available: Boolean(fileResource) });
        return send(res, 200, {
          ...commonHeaders,
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': replayDocumentCsp(config),
          'set-cookie': replayCookie(archiveId, page?.url || target)
        }, replayFileHtml({ archiveId, pageUrl: page?.url || target, navigationId, resource: fileResource, title: page?.title, pending }));
      }
      const sharedPage = !page ? (manifest.sharedPages || []).find((item) => item.url === target) : null;
      if (sharedPage && sharedPage.archiveId !== archiveId && store.getArchive(sharedPage.archiveId)) {
        const sharedHost = archiveReplayHost(sharedPage.archiveId);
        const origin = sharedHost ? `http://${sharedHost}:${config.replayPort}` : `http://${config.host}:${config.replayPort}`;
        const location = `${origin}/archive/${encodeURIComponent(sharedPage.archiveId)}/page?url=${encodeURIComponent(sharedPage.pageUrl || target)}${navigationId ? `&navigationId=${encodeURIComponent(navigationId)}` : ''}${modeQuery}`;
        logEvent('info', 'replay', 'page.shared.redirect', { archiveId, sharedArchiveId: sharedPage.archiveId, pageUrl: safeUrl(target) });
        return send(res, 302, { ...commonHeaders, location, 'content-length': 0 }, null);
      }
      const redirectedPage = !page && !sharedPage ? savedPageForMissingUrl(manifest, target) : null;
      if (redirectedPage && redirectedPage.url !== target) {
        const location = `/archive/${encodeURIComponent(archiveId)}/page?url=${encodeURIComponent(redirectedPage.url)}${navigationId ? `&navigationId=${encodeURIComponent(navigationId)}` : ''}${modeQuery}`;
        logEvent('info', 'replay', 'page.redirect.saved', { archiveId, pageUrl: safeUrl(target), targetUrl: safeUrl(redirectedPage.url) });
        return send(res, 302, { ...commonHeaders, location, 'content-length': 0 }, null);
      }
      if (!page?.html) {
        logEvent('warn', 'replay', 'page.missing', { archiveId, pageUrl: safeUrl(target) });
        const message = replayFailureHtml('このページは保存されていません', target, archiveId, target, navigationId);
        return send(res, 404, { ...commonHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", 'x-webcapture-missing-page': '1' }, message);
      }
      let html;
      try { html = await fs.readFile(path.join(store.archiveRoot(archiveId), page.html), 'utf8'); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        logEvent('error', 'replay', 'page.file.missing', { archiveId, pageUrl: safeUrl(target), code: 'HTML_FILE_NOT_FOUND' });
        return send(res, 404, { ...commonHeaders, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", 'x-webcapture-missing-page': '1' }, replayFailureHtml('保存したページのファイルが見つかりません', target, archiveId, target, navigationId));
      }
      lastPages.set(archiveId, page.url);
      if (light) lightArchives.add(archiveId); else lightArchives.delete(archiveId);
      if (lastPages.size > 200) lastPages.delete(lastPages.keys().next().value);
      logEvent('info', 'replay', 'page.served', { archiveId, pageUrl: safeUrl(target), htmlBytes: Buffer.byteLength(html) });
      return send(res, 200, {
        ...commonHeaders,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': replayDocumentCsp(config),
        'set-cookie': replayCookie(archiveId, page.url)
      }, rewriteHtml(html, page.url, archiveId, manifest.options, navigationId, { capturedAt: page.capturedAt, seedUrl: page.requestedUrl || page.url, light, still, guard: true }));
    }
    if (match[2] === 'post') {
      let lookup = findPostResponse(manifest, {
        method: 'POST', url: target,
        digest: /^[a-f0-9]{64}$/.test(requestUrl.searchParams.get('digest') || '') ? requestUrl.searchParams.get('digest') : '',
        canonical: /^[a-f0-9]{64}$/.test(requestUrl.searchParams.get('canonical') || '') ? requestUrl.searchParams.get('canonical') : ''
      });
      const requestBody = postLookupRequest ? await readLookupBody(req) : null;
      if (!lookup.entry && (lookup.match === 'ambiguous' || lookup.match === 'none')) {
        const similar = await findSimilarPostResponse(manifest, {
          url: target, body: requestBody, contentType: String(req.headers['x-webcapture-request-type'] || ''),
          pageUrl: (() => { try { return decodeURIComponent(String(req.headers['x-webcapture-page'] || '')); } catch { return ''; } })() || currentReplayPage(req, lastPages)?.pageUrl || '',
          readRequestBody: (file) => readArchiveFile(store, archiveId, file)
        });
        if (similar.entry) lookup = similar;
      }
      if (!lookup.entry && (isAuxiliaryRuntimeUrl(target) || isServerBoundaryUrl(target))) {
        logEvent('info', 'replay', 'post.auxiliary.disabled', { archiveId, resourceUrl: safeUrl(target), match: lookup.match });
        return send(res, 204, { ...commonHeaders, 'content-length': 0, 'x-webcapture-auxiliary-disabled': '1' }, null);
      }
      if (!lookup.entry) {
        logEvent('warn', 'replay', 'post.missing', { archiveId, resourceUrl: safeUrl(target), code: 'POST_RESPONSE_NOT_FOUND', match: lookup.match, candidates: lookup.candidates || 0 });
        if (req.headers['x-webcapture-replay-audit'] !== '1') await store.recordReplayMiss?.(archiveId, target).catch(() => {});
        return send(res, 404, { ...commonHeaders, 'content-type': 'text/plain; charset=utf-8', 'x-webcapture-missing-resource': '1' }, '保存されていない送信応答です。');
      }
      let body;
      try { body = await fs.readFile(path.join(store.archiveRoot(archiveId), lookup.entry.file)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        logEvent('error', 'replay', 'post.file.missing', { archiveId, resourceUrl: safeUrl(target), code: 'POST_FILE_NOT_FOUND' });
        return send(res, 404, { ...commonHeaders, 'content-type': 'text/plain; charset=utf-8', 'x-webcapture-missing-resource': '1' }, '保存した送信応答のファイルが見つかりません。');
      }
      let postType = lookup.entry.mimeType || lookup.entry.headers?.['content-type'] || 'application/octet-stream';
      if (isTextualType(postType) && storedTextCharset(body, lookup.entry) === 'utf-8' && charsetFromContentType(postType) && charsetFromContentType(postType) !== 'utf-8') postType = withCharset(postType, 'utf-8');
      const postStatus = Number(lookup.entry.status) >= 200 && Number(lookup.entry.status) <= 599 ? Number(lookup.entry.status) : 200;
      logEvent('info', 'replay', 'post.served', { archiveId, resourceUrl: safeUrl(target), match: lookup.match, bytes: body.length });
      const archivedStatus = postStatus >= 400 ? { 'x-webcapture-archived-status': String(postStatus) } : {};
      if ([204, 205, 304].includes(postStatus)) return send(res, postStatus, { ...commonHeaders, 'content-type': postType, 'content-length': 0, 'x-webcapture-post-match': lookup.match }, null);
      return send(res, postStatus, { ...commonHeaders, ...archivedStatus, 'content-type': postType, 'content-length': body.length, 'x-webcapture-post-match': lookup.match }, body);
    }
    const canonicalTarget = manifest.resourceAliases?.[target] || target;
    const fallback = manifest.resources[canonicalTarget] ? null : findTypekitCompleteFontFallback(manifest, target) || findQueryVariantFallback(manifest, canonicalTarget);
    const baseResource = manifest.resources[canonicalTarget] || fallback?.resource;
    const currentPage = currentReplayPage(req, lastPages);
    const variant = baseResource && currentPage?.archiveId === archiveId
      ? (manifest.resourceVariants?.[canonicalTarget] || []).find((item) => item.pages?.includes(currentPage.pageUrl))
      : null;
    const resource = variant ? { ...baseResource, ...variant, url: baseResource.url } : baseResource;
    const boundary = serverBoundaryReplayResponse(canonicalTarget);
    if (boundary) {
      logEvent('info', 'replay', 'resource.server-boundary.disabled', { archiveId, resourceUrl: safeUrl(target), mimeType: boundary.contentType, bytes: boundary.body.length });
      return send(res, 200, {
        ...commonHeaders,
        'content-type': boundary.contentType,
        'content-length': boundary.body.length,
        'x-webcapture-server-boundary': '1'
      }, boundary.body);
    }
    const auxiliary = auxiliaryReplayResponse(canonicalTarget, resource);
    if (auxiliary) {
      logEvent('info', 'replay', 'resource.auxiliary.disabled', { archiveId, resourceUrl: safeUrl(target), mimeType: auxiliary.contentType, bytes: auxiliary.body.length });
      return send(res, 200, {
        ...commonHeaders,
        'content-type': auxiliary.contentType,
        'content-length': auxiliary.body.length,
        'x-webcapture-auxiliary-disabled': '1'
      }, auxiliary.body);
    }
    if (!resource) {
      logEvent('warn', 'replay', 'resource.missing', { archiveId, resourceUrl: safeUrl(target), code: 'RESOURCE_NOT_FOUND' });
      if (req.headers['x-webcapture-replay-audit'] !== '1') await store.recordReplayMiss?.(archiveId, target).catch((error) => {
        logEvent('warn', 'replay', 'resource.missing.record.failed', { archiveId, code: error.code || 'WRITE_FAILED' });
      });
      return send(res, 404, { ...commonHeaders, 'content-type': 'text/plain; charset=utf-8', 'x-webcapture-missing-resource': '1' }, '未保存の素材です。');
    }
    let type = resource.mimeType || resource.headers?.['content-type'] || 'application/octet-stream';
    const isCss = type.includes('text/css');
    const isHtml = type.includes('text/html');
    const isScript = /javascript|ecmascript/.test(type) || /\.m?js(?:$|\?)/i.test(resource.url);
    const rewritten = isCss || isHtml || isScript;
    const cacheTag = replayCacheTag(config, resource, lightArchives.has(archiveId));
    const cacheControl = !cacheTag ? 'no-store' : rewritten ? 'private, no-cache' : 'private, max-age=86400';
    if (cacheTag && !req.headers.range && req.headers['if-none-match'] === cacheTag) {
      return send(res, 304, { ...commonHeaders, 'cache-control': cacheControl, etag: cacheTag }, null);
    }
    const rewriteKey = rewritten && cacheTag ? `${archiveId}|${resource.url}|${cacheTag}` : null;
    let body = rewriteKey ? rewriteCache.get(rewriteKey) : null;
    if (!body) {
      try { body = await fs.readFile(path.join(store.archiveRoot(archiveId), resource.file)); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (req.headers['x-webcapture-replay-audit'] !== '1') await store.recordReplayMiss?.(archiveId, target);
        logEvent('error', 'replay', 'resource.file.missing', { archiveId, resourceUrl: safeUrl(target), code: 'RESOURCE_FILE_NOT_FOUND' });
        return send(res, 404, { ...commonHeaders, 'content-type': 'text/plain; charset=utf-8', 'x-webcapture-missing-resource': '1' }, '保存した素材のファイルが見つかりません。');
      }
      if (rewritten) {
        const text = decodeStoredText(body, resource);
        if (isCss) body = Buffer.from(rewriteCss(text, resource.url, archiveId));
        else if (isHtml) body = Buffer.from(rewriteHtml(text, resource.url, archiveId, manifest.options, '', { light: lightArchives.has(archiveId) }));
        else body = Buffer.from(rewriteJavaScript(text, resource.url, archiveId));
        if (rewriteKey) rememberRewrite(rewriteKey, body);
      }
    }
    if (rewritten) {
      if (!/^application\/octet-stream/i.test(type)) type = withCharset(type, 'utf-8');
    } else if (isTextualType(type) && storedTextCharset(body, resource) === 'utf-8' && charsetFromContentType(type) && charsetFromContentType(type) !== 'utf-8') {
      type = withCharset(type, 'utf-8');
    }
    logEvent('info', 'replay', 'resource.served', { archiveId, resourceUrl: safeUrl(target), aliasHit: canonicalTarget !== target, fallback: fallback?.kind || null, mimeType: type, bytes: body.length });
    const storedStatus = Number(resource.status);
    const status = storedStatus >= 200 && storedStatus <= 599 ? storedStatus : 200;
    const headers = { ...commonHeaders, 'content-type': type, 'content-length': body.length };
    if (status === 200 && cacheTag) { headers['cache-control'] = cacheControl; headers.etag = cacheTag; }
    if (isHtml) headers['content-security-policy'] = replayDocumentCsp(config);
    if (fallback) headers['x-webcapture-resource-fallback'] = fallback.kind;
    if (variant) headers['x-webcapture-resource-variant'] = '1';
    if (status >= 400) headers['x-webcapture-archived-status'] = String(status);
    if ([204, 205, 304].includes(status)) return send(res, status, { ...headers, 'content-length': 0 }, null);
    if ([301, 302, 303, 307, 308].includes(status) && resource.headers?.location) headers.location = resourceUrl(archiveId, resolveAsset(resource.headers.location, resource.url, archiveId));
    if (status === 206 && resource.headers?.['content-range']) headers['content-range'] = resource.headers['content-range'];
    if (status === 200) {
      headers['accept-ranges'] = 'bytes';
      if (!headers.etag && resource.digest) headers.etag = `"${resource.digest}"`;
      const range = !req.headers['if-range'] || req.headers['if-range'] === headers.etag ? byteRange(req.headers.range, body.length) : null;
      if (range?.unsatisfiable) return send(res, 416, { ...headers, 'content-range': `bytes */${body.length}`, 'content-length': 0 }, null);
      if (range) {
        const part = body.subarray(range.start, range.end + 1);
        return send(res, 206, { ...headers, 'content-range': `bytes ${range.start}-${range.end}/${body.length}`, 'content-length': part.length }, part);
      }
    }
    return send(res, status, headers, body);
  };
}
