// Algo Trading grid: each strategy is switched on per index (NIFTY 50, BANK NIFTY, SENSEX), with its own settings
// where it has any (CE + PE: target price, times, stop, capital … per index). Stored as JSON in broker_accounts.algo_grid:
//   { orb: { NIFTY: { on: true } }, strangle: { NIFTY: { on: true, cfg: { target: 4, … } }, SENSEX: { on: false, cfg: … } } }
// The older single switches (orb_on, cross_on, ema915_on, gap_on, strangle_on) and the ticked indices (algo_underlying)
// are kept in step on every save — "on for some index" and "the indices anything is on for" — so SQL filters, the
// pre-open check and the live feed keep working; an account saved before the grid is read from them.
// Each strategy + index holds at most one trade at a time; different ones can run together (the day's loss limit,
// trade cap, cutoff and kill switch still apply to the total).

export const GRID_INDICES = Object.freeze(['NIFTY', 'BANKNIFTY', 'SENSEX']);
// key → the older switch column and the strategy name stored with each trade (auto_trades.detail.setup.strategy).
export const GRID_STRATEGIES = Object.freeze({
  orb: { column: 'orb_on', name: 'ORB 5m', label: 'ORB 5m' },
  ema59: { column: 'cross_on', name: 'EMA 5/9 1m', label: 'EMA 5/9 crossover 1m' },
  ema915: { column: 'ema915_on', name: 'EMA 9/15 5m', label: 'EMA 9/15 5m · 30°' },
  gap: { column: 'gap_on', name: 'Gap 09:15', label: 'Gap open 09:15' },
  strangle: { column: 'strangle_on', name: 'CE + PE target', label: 'CE + PE at a target price' },
});
// CE + PE: the usual target premium per index (the page fills it in for an index switched on the first time).
export const STRANGLE_INDEX_TARGETS = Object.freeze({ NIFTY: 4, BANKNIFTY: 20, SENSEX: 100 });

const legacyOn = (acct, key) => {
  const v = acct?.[GRID_STRATEGIES[key].column];
  // ORB and EMA 5/9 were on unless switched off (column default 1); the others off unless switched on.
  return key === 'orb' || key === 'ema59' ? v !== 0 : v === 1;
};
const legacyIndices = acct => {
  const keys = String(acct?.algo_underlying || 'NIFTY').split(',').map(k => k.trim().toUpperCase()).filter(k => GRID_INDICES.includes(k));
  return keys.length ? [...new Set(keys)] : ['NIFTY'];
};
const parse = s => { try { const v = JSON.parse(s || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } };

/** The account's grid (from algo_grid, or built from the older switches for an account not saved since). */
export function algoGrid(acct) {
  const saved = parse(acct?.algo_grid), grid = {};
  for (const key of Object.keys(GRID_STRATEGIES)) {
    grid[key] = {};
    for (const U of GRID_INDICES) {
      const cell = saved?.[key]?.[U];
      if (saved) grid[key][U] = { on: !!cell?.on, ...(cell?.cfg ? { cfg: cell.cfg } : {}) };
      else {
        const on = legacyOn(acct, key) && (key === 'strangle' ? U === 'NIFTY' : legacyIndices(acct).includes(U));
        grid[key][U] = { on };
        if (key === 'strangle' && U === 'NIFTY' && acct?.strangle_cfg) grid[key][U].cfg = parse(acct.strangle_cfg) || undefined;
      }
    }
  }
  return grid;
}

export const slotOn = (acct, key, U) => !!algoGrid(acct)[key]?.[U]?.on;
export const slotCfg = (acct, key, U) => algoGrid(acct)[key]?.[U]?.cfg || {};
/** The indices a strategy is switched on for. */
export const strategyIndices = (acct, key) => GRID_INDICES.filter(U => slotOn(acct, key, U));

/** The account as the scanner sees it for one index: each strategy's switch is its switch on that index. */
export function indexView(acct, U) {
  if (!acct) return acct;
  const grid = algoGrid(acct), view = { ...acct };
  for (const [key, s] of Object.entries(GRID_STRATEGIES)) view[s.column] = grid[key]?.[U]?.on ? 1 : 0;
  return view;
}

/** The older columns that follow a grid: a switch is on when its strategy is on for any index; the indices to watch. */
export function legacyColumns(grid) {
  const cols = {};
  for (const [key, s] of Object.entries(GRID_STRATEGIES)) cols[s.column] = GRID_INDICES.some(U => grid[key]?.[U]?.on) ? 1 : 0;
  const watched = GRID_INDICES.filter(U => Object.keys(GRID_STRATEGIES).some(key => grid[key]?.[U]?.on));
  cols.algo_underlying = (watched.length ? watched : ['NIFTY']).join(',');
  const nifty = grid.strangle?.NIFTY?.cfg;
  if (nifty) cols.strangle_cfg = JSON.stringify(nifty);
  return cols;
}
