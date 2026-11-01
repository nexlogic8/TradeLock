// Subscription card (plan, validity, payment, billing summary) used by the Subscription page.
import { html, on } from '../core/dom.js';
import { post } from '../core/api.js';
import { dateIST, paise, inr } from '../core/format.js';
import { icon } from './icons.js';
import { pill } from './parts.js';
import { toast } from './toast.js';
import { payAndVerify } from './razorpay.js';

export const dayStr = ts => (ts ? dateIST(ts) : '–');
const FEATURES = ['Dhan monitoring', 'Risk rules', 'Auto exits & kill switch', 'Alerts & audit history', 'Analytics'];

/** "Have a coupon?" field, or the applied coupon with a Remove link. */
function couponRow(ui) {
  const q = ui.quote;
  if (q?.coupon) {
    return html`
      <div class="coupon-applied">
        <span class="coupon-tag">${icon('tag')}<b class="num">${q.coupon.code}</b></span>
        <span class="grow small">${q.coupon.label}</span>
        <button type="button" class="link-btn small" id="coupon-remove">Remove</button>
      </div>`;
  }
  if (!ui.couponOpen) return html`<button type="button" class="link-btn small coupon-open" id="coupon-open">${icon('tag')}Have a coupon code?</button>`;
  return html`
    <div class="coupon-form">
      <input class="input num" id="coupon-code" placeholder="Enter coupon code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24" value="${ui.couponCode || ''}">
      <button type="button" class="btn" id="coupon-apply">Apply</button>
    </div>
    ${ui.couponError ? html`<span class="tiny neg">${ui.couponError}</span>` : ''}`;
}

/** Pay box: optional coupon, optionally use the wallet, pay the rest with Razorpay. */
function payBox(ctx, sub) {
  const b = ctx.data.billing;
  if (!b?.wallet) return '';
  const q = ctx.ui.quote;   // price with the applied coupon, if any
  const months = q?.months || 1;
  const total = q ? q.total : b.total;
  const use = ctx.ui.useWallet ??= b.wallet.total > 0;
  const fromWallet = use ? Math.min(b.wallet.total, total) : 0;
  const due = total - fromWallet;
  const provider = ctx.state.meta?.payments;
  const paid = sub.status === 'active' && sub.active;
  const span = `${months} month${months === 1 ? '' : 's'}`;
  return html`
    <div class="sub-box">
      <h4>${paid ? `Extend by ${months === 1 ? 'a month' : span}` : sub.status === 'trial' || sub.active ? 'Subscribe now' : 'Renew now'}</h4>
      ${couponRow(ctx.ui)}
      <label class="check-row">
        <input type="checkbox" id="use-wallet" ${use ? 'checked' : ''} ${b.wallet.total > 0 ? '' : 'disabled'}>
        <span class="grow">${icon('wallet')} Use wallet balance <span class="dim">(${paise(b.wallet.total)} available)</span></span>
      </label>
      <div class="sub-lines">
        ${q?.coupon ? html`
          <div><span class="muted">Plan · ${span}</span><span class="num">${paise(q.base)}</span></div>
          <div><span class="muted">Coupon ${q.coupon.code}</span><span class="num pos">−${paise(q.discount)}</span></div>
          <div><span class="muted">GST (${Math.round(sub.gstRate * 100)}%)</span><span class="num">${paise(q.gst)}</span></div>` : ''}
        <div><span class="muted">Total</span><span class="num">${paise(total)}</span></div>
        ${fromWallet ? html`<div><span class="muted">From wallet</span><span class="num pos">−${paise(fromWallet)}</span></div>` : ''}
        <div class="sub-due"><b>Pay now</b><b class="num">${paise(due)}</b></div>
      </div>
      ${total === 0
        ? html`<button class="btn btn-primary btn-block" id="checkout">${icon('check')}Activate ${span} free</button>`
        : due === 0
        ? html`<button class="btn btn-primary btn-block" id="checkout">${icon('check')}Pay ${paise(total)} from wallet</button>`
        : provider
          ? html`<button class="btn btn-primary btn-block" id="checkout">${icon('lock')}Pay ${paise(due)} securely</button>
             <span class="tiny dim sub-methods">UPI · Cards · Netbanking · Wallets, via Razorpay</span>`
          : html`<p class="muted small" style="margin:0">Online payments are not set up yet.</p>`}
      ${paid ? html`<span class="tiny dim">Adds ${months * 30} days after ${dayStr(sub.currentPeriodEnd)}.</span>`
        : sub.status === 'trial' && sub.active ? html`<span class="tiny dim">Your remaining trial days are kept: the paid ${months === 1 ? 'month starts' : 'months start'} after the trial.</span>` : ''}
    </div>`;
}

/** Plan status, validity, payment and billing summary in one place. */
export function subscriptionPanel(ctx, sub) {
  if (!sub) return '';
  const billing = ctx.data.billing;
  const now = Date.now();
  const paid = sub.status === 'active';
  const ended = !sub.active;
  const end = paid ? sub.currentPeriodEnd : sub.trialEndsAt;
  const daysLeft = end ? Math.max(0, Math.ceil((end - now) / 864e5)) : 0;
  const gst = sub.priceInr * sub.gstRate;
  const used = ended ? 100 : Math.max(4, Math.min(100, 100 - (daysLeft / (paid ? 30 : 7)) * 100));
  const status = ended ? pill(paid ? 'Ended' : sub.trialBlocked ? 'No free trial' : 'Trial ended', 'red', { dot: true })
    : paid ? pill('Active', '', { dot: true, pulse: true }) : pill('Free trial', 'ice', { dot: true });
  return html`
    <div class="panel pad mt sub-card ${paid && !ended ? 'paid' : ''}" id="subscription">
      ${sub.trialBlocked && !sub.active ? html`<div class="banner amber mb">${icon('alert')}<div class="grow"><b>Free trial not available.</b> ${sub.trialBlocked} (one free trial per person). Subscribe below to turn on protection.</div></div>` : ''}
      <div class="sub-top">
        <div class="sub-plan">
          <span class="sub-ico">${icon('card')}</span>
          <div><span class="eyebrow">Subscription</span><h3>${sub.plan} ${status}</h3>
            <span class="muted small">₹${sub.priceInr} / month + ${Math.round(sub.gstRate * 100)}% GST</span></div>
        </div>
        <div class="sub-when">
          <span class="muted small">${ended ? 'Ended on' : paid ? 'Active until' : 'Trial ends on'}</span>
          <b class="num">${dayStr(end)}</b>
          <span class="tiny ${ended ? 'neg' : daysLeft <= 3 ? 'warn' : 'dim'}">${ended ? 'Monitoring is paused' : `${daysLeft} day${daysLeft === 1 ? '' : 's'} left`}</span>
        </div>
      </div>
      <div class="sub-meter"><i style="width:${used}%"></i></div>
      <div class="sub-feats">${FEATURES.map(f => html`<span>${icon('check')}${f}</span>`)}</div>

      <div class="sub-cols">
        ${payBox(ctx, sub)}
        <div class="sub-box">
          <h4>Billing summary</h4>
          <div class="sub-lines">
            <div><span class="muted">Monthly plan</span><span class="num">${inr(sub.priceInr, { dp: 2 })}</span></div>
            <div><span class="muted">GST (${Math.round(sub.gstRate * 100)}%)</span><span class="num">${inr(gst, { dp: 2 })}</span></div>
            <div class="sub-due"><b>Total per month</b><b class="num">${inr(sub.priceInr + gst, { dp: 2 })}</b></div>
            ${billing?.wallet ? html`<div><span class="muted">Wallet balance</span><span class="num">${paise(billing.wallet.total)}</span></div>` : ''}
          </div>
          <p class="tiny dim" style="margin:0">No auto-debit: you pay each month yourself. GST is included at checkout and Razorpay emails your receipt.</p>
        </div>
      </div>
    </div>`;
}


/** Wallet toggle and pay / extend. */
export function bindSubscription(ctx) {
  const { el, signal, ui } = ctx;
  on(el, 'change', '#use-wallet', (_, c) => { ui.useWallet = c.checked; ctx.paint(); }, signal);
  // Coupons: check the code with the server and show the new price.
  on(el, 'click', '#coupon-open', () => { ui.couponOpen = true; ctx.paint(); el.querySelector('#coupon-code')?.focus(); }, signal);
  const apply = async () => {
    const input = el.querySelector('#coupon-code');
    const code = input?.value.trim();
    if (!code) return;
    ui.couponCode = code;
    try {
      ui.quote = (await post('/billing/quote', { coupon: code })).quote;
      ui.couponError = null;
      toast(`Coupon ${ui.quote.coupon.code} applied: ${ui.quote.coupon.label}.`);
    } catch (e) { ui.quote = null; ui.couponError = e.message; }
    ctx.paint();
  };
  on(el, 'click', '#coupon-apply', apply, signal);
  on(el, 'keydown', '#coupon-code', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }, signal);
  on(el, 'click', '#coupon-remove', () => { ui.quote = null; ui.couponCode = ''; ui.couponOpen = false; ctx.paint(); }, signal);
  on(el, 'click', '#checkout', async (_, b) => {
    b.disabled = true;
    try {
      const coupon = ui.quote?.coupon?.code || null;
      const months = ui.quote?.months || 1;
      const res = await post('/billing/checkout', { useWallet: !!ui.useWallet, coupon });
      if (!res.paid && res.provider === 'razorpay') await payAndVerify(post, res, `${ctx.data.billing.subscription.plan} · ${months} month${months === 1 ? '' : 's'}`);
      toast(ui.quote?.total === 0 ? 'Coupon applied. TradeLock Pro is active!' : 'Payment received. TradeLock Pro is active. Thank you!');
      ui.quote = null; ui.couponCode = ''; ui.couponOpen = false;
      await ctx.reload();
    } catch (e) { toast(e.message, e.message === 'Payment cancelled.' ? 'warn' : 'error'); b.disabled = false; }
  }, signal);
}
