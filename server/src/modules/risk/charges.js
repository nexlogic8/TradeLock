// Today's trading charges, estimated from today's fills (Dhan reports the real charges only from the next day).
// Rates as on Dhan's contract notes for index and MCX options (checked against this account's 11–13 Nov 2026 charges):
//   brokerage ₹20 per executed order; STT 0.15% of option sells (MCX: CTT 0.05%); exchange charges NSE 0.03503%,
//   BSE 0.0325%, MCX 0.0418% of turnover; SEBI ₹10 per crore; stamp duty 0.003% of buys; GST 18% on brokerage,
//   exchange and SEBI charges. Shown to the user as an estimate; risk rules keep using the broker's P&L.
export const CHARGE_RATES = Object.freeze({
  brokeragePerOrder: 20,
  stt: { NSE: 0.0015, BSE: 0.0015, MCX: 0.0005 },
  exchange: { NSE: 0.0003503, BSE: 0.000325, MCX: 0.000418 },
  sebiPerCrore: 10,
  stamp: 0.00003,
  gst: 0.18,
});

/** Exchange of a fill from Dhan's trading symbol: MCX commodities, BSE (SENSEX / BANKEX), else NSE. */
export function exchangeOf(symbol) {
  const s = String(symbol || '').toUpperCase();
  if (/^(CRUDEOIL|GOLD|SILVER|NATURALGAS|COPPER|ZINC|ALUMINI|LEAD|NICKEL)/.test(s)) return 'MCX';
  if (/^(SENSEX|BANKEX|SX)/.test(s)) return 'BSE';
  return 'NSE';
}
// MCX: Dhan's positions and today's trades count quantity in LOTS; the price is per quoted unit. Rupees per point per
// lot = the lot in quoted units (CRUDEOIL: 100 barrels, the mini 10; GOLD: 1 kg quoted per 10 g = 100, the mini 10…).
// Longest names first (CRUDEOILM before CRUDEOIL). The trade history's "CRUDEOIL 17 NOV 8000 PUT" rows count units.
const MCX_LOT_VALUE = [
  ['CRUDEOILM', 10], ['CRUDEOIL', 100], ['GOLDPETAL', 1], ['GOLDGUINEA', 1], ['GOLDM', 10], ['GOLD', 100],
  ['SILVERMIC', 1], ['SILVERM', 5], ['SILVER', 30], ['NATGASMINI', 250], ['NATURALGAS', 1250],
  ['COPPER', 2500], ['ZINC', 5000], ['ALUMINIUM', 5000], ['ALUMINI', 1000], ['LEAD', 5000], ['NICKEL', 1500],
];
/** Rupees per 1 point per 1 unit of Dhan quantity for an MCX trading symbol ("CRUDEOIL-17Nov2026-8000-PE"); 1 elsewhere. */
export function mcxLotValue(symbol) {
  const s = String(symbol || '').toUpperCase();
  return MCX_LOT_VALUE.find(([name]) => s.startsWith(name))?.[1] ?? 1;
}
/** Per fill: today's trades ("NAME-17Nov2026-…") count MCX lots; history rows ("NAME 17 NOV …") count units. */
// TradeLock's own contract names ("GOLDM 2026-11-27 131000 PE", paper trades) count lots as well.
export const fillMultiplier = symbol => (exchangeOf(symbol) === 'MCX' && /^[A-Z]+(-| \d{4}-\d{2}-\d{2} )/i.test(String(symbol || '')) ? mcxLotValue(symbol) : 1);

const r2 = v => Math.round(v * 100) / 100;

/** fills: [{ symbol, side 'BUY'|'SELL', qty, price, orderId }] → { total, brokerage, stt, exchange, sebi, stamp, gst, orders } */
export function estimateCharges(fills, rates = CHARGE_RATES) {
  const orders = new Set();
  let stt = 0, exchange = 0, turnover = 0, stamp = 0, unnamed = 0;
  for (const f of fills || []) {
    const qty = Number(f.qty) || 0, price = Number(f.price) || 0;
    if (!(qty > 0) || !(price > 0)) continue;
    const exch = exchangeOf(f.symbol), value = qty * price * fillMultiplier(f.symbol), sell = String(f.side).toUpperCase() === 'SELL';
    if (f.orderId) orders.add(String(f.orderId)); else unnamed++;
    turnover += value;
    exchange += value * rates.exchange[exch];
    if (sell) stt += value * rates.stt[exch]; else stamp += value * rates.stamp;
  }
  const count = orders.size + unnamed, brokerage = count * rates.brokeragePerOrder, sebi = turnover * rates.sebiPerCrore / 1e7;
  const gst = rates.gst * (brokerage + exchange + sebi);
  const parts = { brokerage, stt, exchange, sebi, stamp, gst };
  return { ...Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, r2(v)])), total: r2(Object.values(parts).reduce((a, b) => a + b, 0)), orders: count };
}
