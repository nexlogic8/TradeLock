// Overview: the rule set not in force now (Manual trading / Algo Trading), when its daily stop-loss is on and differs
// from the active one: { key, amount }, else null. Drawn as a second stop-loss line on the intraday chart.
export function otherSl(d) {
  const sl = d.stopLosses, key = sl?.mode === 'algo' ? 'manual' : 'algo', x = sl?.[key];
  return x?.on && x.amount > 0 && x.amount !== d.limits?.maxLoss ? { key, amount: x.amount } : null;
}

// The same for the profit target: the other set's target when it is on and differs from the one in force
// (also when the set in force has none), else null. Drawn as a second target line in its own color.
export function otherTarget(d) {
  const t = d.profitTargets, key = t?.mode === 'algo' ? 'manual' : 'algo', x = t?.[key];
  return x?.on && x.amount > 0 && x.amount !== d.limits?.profitLock ? { key, amount: x.amount } : null;
}

/**
 * The day's P&L split into Algo Trading and manual trading, from the intraday points ({ minute, pnl, algo }):
 * { algo: [[minute, ₹]], manual: [[minute, ₹]], algoNow, manualNow, both } or null when no point carries the split
 * (Algo Trading has not traded today). `both`: each part has moved, so two lines say more than the total alone.
 */
export function pnlSplit(points) {
  if (!points.some(p => p.algo != null)) return null;
  const algo = points.map(p => [p.minute, p.algo ?? 0]), manual = points.map(p => [p.minute, p.pnl - (p.algo ?? 0)]);
  const moved = pts => pts.some(p => Math.abs(p[1]) >= 0.5);
  return { algo, manual, algoNow: algo.at(-1)[1], manualNow: manual.at(-1)[1], both: moved(algo) && moved(manual) };
}
