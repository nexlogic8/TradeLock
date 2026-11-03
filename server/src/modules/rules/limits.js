// Pure helpers: turn a money rule into rupees. Rules are either a fixed amount or a percentage
// of the day's starting capital (the broker's opening balance, frozen at the first sync of the day).

/** Rupee limit for a rule, or null when it is a percentage and capital is not known yet. */
export function limitAmount(rule, capital) {
  if (rule.mode !== 'percent') return rule.value;
  return capital > 0 ? Math.round(capital * rule.value) / 100 : null;
}

/**
 * Booked profit at which the profit give-back rule starts protecting: the same amount as the daily
 * stop-loss (its % of capital or fixed ₹ setting), so risk and protected reward are the same size.
 * Uses the stop-loss setting even while that rule is switched off. Null until capital is known.
 */
export const givebackArmAt = (rules, capital) => limitAmount(rules.maxLoss, capital);

export const limitsFor = (rules, capital) => ({
  maxLoss: limitAmount(rules.maxLoss, capital),
  profitLock: limitAmount(rules.profitLock, capital),
});

/** Most one trade may use in rupees (Capital per trade), or null when that rule is off or capital is not known yet. */
export const capitalLimit = (rules, capital) => (rules?.capitalUse?.on ? limitAmount(rules.capitalUse, capital) : null);
