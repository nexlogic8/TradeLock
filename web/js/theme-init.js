// Runs before the page paints (classic script in <head>) so there is no flash of the wrong theme.
(function () {
  var pref = 'dark';
  try { pref = localStorage.getItem('tl-theme') || 'dark'; } catch (e) { /* storage blocked */ }
  var theme = pref === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
  document.documentElement.setAttribute('data-theme', theme);
})();
