(function () {
  var root = document.documentElement;
  try {
    var prefs = JSON.parse(localStorage.getItem('webcapture.uiPrefs') || localStorage.getItem('sitevault.uiPrefs') || '{}') || {};
    var systemDark = Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = prefs.theme === 'dark' || (prefs.theme === 'system' && systemDark) ? 'dark' : 'light';
    if (prefs.language === 'en') root.lang = 'en';
  } catch (error) {
    root.dataset.theme = 'light';
  }
})();
