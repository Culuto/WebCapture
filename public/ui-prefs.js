export const UI_PREFS_KEY = 'webcapture.uiPrefs';
export const LEGACY_UI_PREFS_KEY = 'sitevault.uiPrefs';
export const THEMES = Object.freeze(['light', 'dark', 'system']);
export const LANGUAGES = Object.freeze(['ja', 'en']);
export const MAX_URL_PATTERNS = 50;

export const DEFAULT_UI_PREFS = Object.freeze({
  theme: 'light',
  language: 'ja',
  legacyKeywords: false,
  excludeUrlPatterns: '',
  includeUrlPatterns: ''
});

export function sanitizeUiPrefs(value) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    theme: THEMES.includes(input.theme) ? input.theme : DEFAULT_UI_PREFS.theme,
    language: LANGUAGES.includes(input.language) ? input.language : DEFAULT_UI_PREFS.language,
    legacyKeywords: input.legacyKeywords === true,
    excludeUrlPatterns: typeof input.excludeUrlPatterns === 'string' ? input.excludeUrlPatterns.slice(0, 20000) : '',
    includeUrlPatterns: typeof input.includeUrlPatterns === 'string' ? input.includeUrlPatterns.slice(0, 20000) : ''
  };
}

export function readUiPrefs(storage) {
  try { return sanitizeUiPrefs(JSON.parse(storage?.getItem(UI_PREFS_KEY) || storage?.getItem(LEGACY_UI_PREFS_KEY) || '{}')); } catch { return sanitizeUiPrefs({}); }
}

export function writeUiPrefs(storage, prefs) {
  try { storage?.setItem(UI_PREFS_KEY, JSON.stringify(sanitizeUiPrefs(prefs))); return true; } catch { return false; }
}

export function resolveTheme(theme, systemPrefersDark) {
  if (theme === 'dark') return 'dark';
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light';
  return 'light';
}

export function urlPatternList(text) {
  const seen = new Set();
  const patterns = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const pattern = value.includes('*') ? value : `*${value}*`;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    patterns.push(pattern);
    if (patterns.length >= MAX_URL_PATTERNS) break;
  }
  return patterns;
}
