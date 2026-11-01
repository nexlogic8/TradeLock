import { html } from '../core/dom.js';
const money = n => Number(n).toLocaleString('en-IN', { maximumFractionDigits:2 });

export function signalPanel(ui) {
  const risk = ui.signalRisk, budget = risk?.budget, signal = ui.aiSignal;
  const expired = signal?.expiresAt && Date.now() >= signal.expiresAt;
  const contract = !expired ? signal?.contract : null;
  return html`<section class="sc-ai-signal" aria-label="AI signal">
    <div class="sc-ai-head"><b>AI signal</b><span class="pill sm ice">SIGNAL ONLY</span>
      <button type="button" class="btn btn-ghost btn-sm" id="sc-ai-scan" ${ui.signalBusy || !risk?.scanAllowed ? 'disabled' : ''}>${ui.signalBusy ? 'Scanning…' : 'Scan'}</button></div>
    <small>${budget ? `${money(budget.dailyPct)}% ÷ ${budget.trades} trades = ${money(budget.percent)}% / trade · ₹${money(budget.perTrade)}` : 'Risk rules required'}</small>
    ${budget && budget.available < budget.perTrade ? html`<small>Remaining risk cap: ₹${money(budget.available)}</small>` : ''}
    ${risk?.reason ? html`<small class="neg">${risk.reason} Signal scans remain available.</small>` : ''}
    <small>ORB setup · several trades a day · 09:15–09:20 range · 1m close beyond it, next candle must break that candle’s high/low and close green/red with a body ≥30% of its range (entry at its close) · next 2 upcoming expiries (today excluded) · size capped by per-trade risk</small>
    ${signal?.expiriesScanned?.length ? html`<small>Expiries compared: ${signal.expiriesScanned.join(' · ')}</small>` : ''}
    ${signal?.setup?.high ? html`<small>Opening range 09:15–09:20 · H ₹${money(signal.setup.high)} / L ₹${money(signal.setup.low)}${signal.setup.breakoutAt ? ` · 1m breakout ${new Date(signal.setup.breakoutAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})} IST` : ''}${signal.setup.confirmedAt ? ` · confirmed ${new Date(signal.setup.confirmedAt).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})} IST` : ''}${signal.setup.breakoutClose ? ` · close ₹${money(signal.setup.breakoutClose)}` : ''}</small>` : ''}
    <div class="sc-ai-result" role="status">${ui.signalBusy ? 'Scanning today’s 1m candles, expiries and pre-breakout swings…' : ui.signalError || risk?.scanReason || (expired ? 'Signal expired — scan again.' : signal?.action === 'NO_TRADE' ? `No trade · ${signal.rationale}` : !contract ? 'Scan for a CE/PE idea. TradeLock will show if your rules block entry.' : '')}</div>
    ${contract ? html`<details open><summary class="${contract.entryAllowed ? 'pos' : 'neg'}">${contract.entryAllowed ? 'BUY' : 'SIGNAL ONLY · ENTRY BLOCKED'} ${contract.strike} ${contract.option} · ${contract.expiry}</summary>
      <div class="sc-ai-levels"><span>Buy <b>${contract.option} ${contract.strike} · ${contract.expiry}</b></span><span>${signal.setup?.stale ? 'Entry after first breakout' : 'Entry ask'} <b>₹${money(contract.entry)}${signal.setup?.stale && contract.entryTime ? ` · ${new Date(contract.entryTime).toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit'})} IST` : ''}</b></span><span>SL <b>₹${money(contract.stop)}</b></span><span>${signal.setup?.stale ? 'Model qty' : 'Qty'} <b>${contract.quantity} (${contract.lots} lots)${signal.setup?.stale ? ' · historical' : contract.entryAllowed ? '' : ' · blocked'}</b></span><span>1 lot risk <b>₹${money(contract.oneLotRisk)}</b></span><span>Capital needed <b>₹${money(contract.capitalRequired ?? contract.premium ?? contract.oneLotCapital ?? (contract.entry * contract.quantity))}</b></span></div>
      ${!contract.entryAllowed ? html`<small class="neg">${contract.blockReason || 'Your risk rules do not permit a new entry.'} This is an informational signal; no order was sent.</small>` : ''}
      <small>Pre-breakout swing ₹${money(contract.swingLow)} · stop buffer 1 tick (₹${money(contract.tickSize)}) · ${Math.round(signal.confidence*100)}% confidence</small>
      <small>${signal.rationale}</small><small>Snapshot ${new Date(signal.asOf).toLocaleTimeString('en-IN', { timeZone:'Asia/Kolkata' })} IST · valid 60s. Planned risk excludes fees and slippage. No stop order placed.</small>
    </details>` : ''}
  </section>`;
}
