import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const detail = path.join(root, 'AppDetail');
const name = 'WebCapture';
const required = [
  'Appdetail.md', `Appicon_${name}.png`, `Appinfo_${name}.json`, `Apptheme_${name}.json`, `AppLaunch_${name}.json`,
  `Appboot_${name}.vbs`, `Appboot-background_${name}.vbs`, `Appstop_${name}.vbs`, `Appstop-background_${name}.vbs`,
  `AppReload_${name}.vbs`, `AppReload-background_${name}.vbs`, 'Apptheme/README.md',
  `Detail/${name}Controller.ps1`, `Detail/Integration_${name}.md`
];
for (const file of required) await access(path.join(detail, file));
const [info, theme, launch, packageJson, config, integration] = await Promise.all([
  readFile(path.join(detail, `Appinfo_${name}.json`), 'utf8').then(JSON.parse),
  readFile(path.join(detail, `Apptheme_${name}.json`), 'utf8').then(JSON.parse),
  readFile(path.join(detail, `AppLaunch_${name}.json`), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'app.config.json'), 'utf8').then(JSON.parse),
  readFile(path.join(detail, 'Detail', `Integration_${name}.md`), 'utf8')
]);
const appDetailSpecPath = path.resolve(root, config.appDetailSpecPath || 'AppDetail/Appdetail.md');
for (const key of ['Appname','Systemname','info','info-detail','Version','type','Developer-name','terminal','functiontag']) if (!(key in info)) throw new Error(`Appinfo.${key} がありません。`);
if (info.info.length > 30 || info.Version !== packageJson.version || info.Version !== config.version || info.Systemname !== name) throw new Error('Appinfoがアプリ設定と一致しません。');
for (const key of ['maincolor','Accentcolor','background','fontcolor','darklight','LiquidGlass','color']) if (!(key in theme)) throw new Error(`Apptheme.${key} がありません。`);
if (theme.maincolor !== config.mainColor || theme.Accentcolor !== config.accentColor || theme.fontcolor !== config.fontColor) throw new Error('Appthemeが設定と一致しません。');
const base = `http://${config.host}:${config.port}/`;
if (launch.bootURL !== base || launch.healthURL !== `${base}api/health` || launch.apiBaseURL !== `${base}api` || launch.replayOrigin !== `http://${config.host}:${config.replayPort}` || launch.healthContract?.app !== name || launch.healthContract?.version !== config.version || launch.healthContract?.replayReady !== true) throw new Error('AppLaunchの起動契約が不正です。');
if (launch.iframe?.allowed !== true || JSON.stringify(launch.iframe.parentOrigins) !== JSON.stringify(config.iframeParentOrigins)) throw new Error('iframe契約が不正です。');
if (config.iframeParentOrigins.some((value) => { const origin = new URL(value); return !['127.0.0.1','localhost'].includes(origin.hostname) || origin.origin !== value || !integration.includes(value); })) throw new Error('iframeParentOriginsが不正です。');
for (const term of ['SHA-256', 'collection.warc.gz', 'Public Suffix List', 'CSRF', 'Notsupported']) if (!integration.includes(term)) throw new Error(`Integration情報に ${term} がありません。`);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
if (sha256(await readFile(appDetailSpecPath)) !== sha256(await readFile(path.join(detail, 'Appdetail.md')))) throw new Error('同梱Appdetail.mdが原本と一致しません。');
const icon = await readFile(path.join(detail, `Appicon_${name}.png`));
if (!icon.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('AppIconがPNGではありません。');
const controller = path.join(detail, 'Detail', `${name}Controller.ps1`);
const controllerText = await readFile(controller, 'utf8');
for (const term of ['processStartTime','server\\server.mjs','chrome.exe','msedge.exe','PID ownership check failed.']) if (!controllerText.includes(term)) throw new Error(`Controllerに ${term} がありません。`);
const syntax = spawnSync('powershell.exe', ['-NoProfile','-Command', `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${controller.replaceAll("'", "''")}', [ref]$null, [ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}`], { encoding:'utf8', windowsHide:true });
if (syntax.status !== 0) throw new Error(`Controllerの構文が不正です: ${syntax.stderr || syntax.stdout}`);
for (const [file, action] of [[`Appboot_${name}.vbs`,'boot'],[`Appboot-background_${name}.vbs`,'boot-background'],[`Appstop_${name}.vbs`,'stop'],[`Appstop-background_${name}.vbs`,'stop-background'],[`AppReload_${name}.vbs`,'reload'],[`AppReload-background_${name}.vbs`,'reload-background']]) {
  const content = await readFile(path.join(detail, file), 'utf8');
  if (!content.includes(`${name}Controller.ps1`) || !content.includes(`-Action ${action}`) || !content.includes(', 0, False')) throw new Error(`${file} の非表示起動契約が不正です。`);
}
console.log(`AppDetail check passed (${required.length} files)`);
