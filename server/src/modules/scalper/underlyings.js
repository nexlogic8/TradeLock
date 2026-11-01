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
