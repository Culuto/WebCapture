import childProcess from 'node:child_process';
import { logEvent } from './logger.mjs';

const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character]);
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

export function toastScript(title, message) {
  const xml = `<toast><visual><binding template='ToastGeneric'><text>${escapeXml(title)}</text><text>${escapeXml(message)}</text></binding></visual></toast>`;
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$xml.LoadXml('${escapePowerShell(xml)}')`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${escapePowerShell(POWERSHELL_APP_ID)}').Show($toast)`
  ].join('\n');
}

export function notifyDesktop(title, message) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const encoded = Buffer.from(toastScript(title, message), 'utf16le').toString('base64');
  return new Promise((resolve) => {
    childProcess.execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000 }, (error) => {
      if (error) logEvent('warn', 'notify', 'toast.failed', { message: error.message.slice(0, 200) });
      else logEvent('info', 'notify', 'toast.shown', { title });
      resolve(!error);
    });
  });
}
