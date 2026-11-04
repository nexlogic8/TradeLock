// Overview: the rule set not in force now (Manual trading / Algo Trading), when its daily stop-loss is on and differs
// from the active one: { key, amount }, else null. Drawn as a second stop-loss line on the intraday chart.
export function otherSl(d) {
  const sl = d.stopLosses, key = sl?.mode === 'algo' ? 'manual' : 'algo', x = sl?.[key];
  return x?.on && x.amount > 0 && x.amount !== d.limits?.maxLoss ? { key, amount: x.amount } : null;
}
