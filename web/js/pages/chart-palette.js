// Chart colours per theme. Dark keeps TradeLock's neon look; light uses deeper, saturated colours that
// stay crisp on white (the dark palette's mint, pink and yellow wash out there). EMA lines get their own
// colours in both themes so they never blend into the candles.
const DARK = {
  bg: null, grid: null, text: '#9aa8ba', crosshair: '#8d9aab66',
  up: '#21d3a3', down: '#ff536f', upRgb: '35, 211, 163', downRgb: '255, 83, 111',
  ema9: '#4ea1ff', ema21: '#f5b942', oi: '#e7c66b',
  orb: '#f5b942', cross: '#7c9cff', orHigh: '#ffbf47', orLow: '#5da9ff', prevHigh: '#d78bff', prevLow: '#93a7bd', poc: 'rgba(226, 232, 240, 0.55)', vpAlpha: [0.34, 0.14], volAlpha: 0.28,
};
const LIGHT = {
  bg: '#ffffff', grid: '#edf0f5', text: '#3b4656', crosshair: '#47556999',
  up: '#089981', down: '#e5304b', upRgb: '8, 153, 129', downRgb: '229, 48, 75',
  ema9: '#2962ff', ema21: '#e65100', oi: '#a16207',
  orb: '#b45309', cross: '#4338ca', orHigh: '#b45309', orLow: '#1d4ed8', prevHigh: '#7e22ce', prevLow: '#475569', poc: 'rgba(15, 23, 42, 0.45)', vpAlpha: [0.2, 0.08], volAlpha: 0.32,
};

export const chartTheme = () => (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
export const chartPalette = () => (chartTheme() === 'light' ? LIGHT : DARK);
