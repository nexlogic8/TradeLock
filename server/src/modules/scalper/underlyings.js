// Indices Power Scalper can trade (Dhan ids confirmed against the live option-chain API).
// NIFTY and BANKNIFTY options trade on NSE, SENSEX options on BSE.
//   expiryRule 'weekday': the NIFTY default (2nd expiry Mon-Tue, current Wed-Fri, see expiry.js);
//   'nearest': the nearest active expiry (BANKNIFTY has monthly expiries only; SENSEX weekly on Thursday).
export const UNDERLYINGS = Object.freeze({
  NIFTY:     { key:'NIFTY',     label:'NIFTY 50',   symbol:'NIFTY',     securityId:'13', exchange:'NSE', optionSegment:'NSE_FNO', expiryRule:'weekday' },
  BANKNIFTY: { key:'BANKNIFTY', label:'BANK NIFTY', symbol:'BANKNIFTY', securityId:'25', exchange:'NSE', optionSegment:'NSE_FNO', expiryRule:'nearest' },
  SENSEX:    { key:'SENSEX',    label:'SENSEX',     symbol:'SENSEX',    securityId:'51', exchange:'BSE', optionSegment:'BSE_FNO', expiryRule:'nearest' },
});
export const underlyingFor = key => UNDERLYINGS[String(key || '').toUpperCase()] || UNDERLYINGS.NIFTY;
export const isIndexId = id => Object.values(UNDERLYINGS).some(u => u.securityId === String(id));

// MCX commodity options in Power Scalper (manual trading only, 14 Nov 2026). Not in UNDERLYINGS: Algo Trading and the
// history jobs stay on the indices. Their options sit on a futures contract, so `securityId` is filled in per request
// with the near-month future (instruments.js mcxFutures); Dhan's option chain for that future lists every option expiry.
// Dhan counts MCX quantity in lots (its lot size is 1). `multiplier`: rupees per point per lot (checked against Dhan's
// margin calculator: 1 lot of a ₹507.95 CRUDEOILM call = ₹5,079.50). MCX trades 09:00 to 23:30 / 23:55 (US summer / winter time).
const MCX = { exchange:'MCX', optionSegment:'MCX_COMM', underlyingSeg:'MCX_COMM', spotInstrument:'FUTCOM', optionInstrument:'OPTFUT', expiryRule:'nearest', mcx:true, sessionOpen: 9 * 60, sessionClose: 23 * 60 + 55 };
export const MCX_UNDERLYINGS = Object.freeze({
  CRUDEOILM: Object.freeze({ ...MCX, key:'CRUDEOILM', label:'CRUDE OIL MINI', symbol:'CRUDEOILM', multiplier:10 }),
  GOLDM:     Object.freeze({ ...MCX, key:'GOLDM',     label:'GOLD MINI',      symbol:'GOLDM',     multiplier:10 }),
});
/** Power Scalper's instruments: the indices plus MCX. */
export const scalperUnderlyingFor = key => MCX_UNDERLYINGS[String(key || '').toUpperCase()] || underlyingFor(key);
/** Rupees per point per lot for an MCX option symbol ("CRUDEOILM 2026-11-17 8300 CE"), else null. */
export const mcxMultiplier = symbol => Object.values(MCX_UNDERLYINGS).find(u => String(symbol || '').toUpperCase().startsWith(`${u.symbol} `))?.multiplier ?? null;
