import { html, $, on } from '../core/dom.js';
import { get, post, put } from '../core/api.js';
import { store } from '../core/store.js';
import { inr, paise, ago, dateIST, hmIST } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { pill, formError, empty, brokerMark } from '../ui/parts.js';
import { toast } from '../ui/toast.js';
import { payAndVerify } from '../ui/razorpay.js';

const CHIPS = [1, 500, 1000, 2000, 5000];
const TYPE = {
  topup: ['Added to wallet', 'pos'], subscription: ['TradeLock Pro', ''], commission: ['Referral commission', 'pos'],
  withdrawal: ['Withdrawal', ''], withdrawal_reversal: ['Withdrawal returned', 'pos'], adjustment: ['Adjustment', ''],
};
const STATUS = { requested: ['Processing', 'ice'], paid: ['Paid', ''], rejected: ['Returned', 'amber'] };

function balanceCards(w, d) {
  const b = w.balances;
  const f = d?.funds;
  return html`
    <div class="wallet-cards two">
      <div class="panel kpi wallet-total">
        <div class="lbl">TradeLock wallet</div>
        <div class="val val-ic">${icon('wallet')}${paise(b.total)}</div>
        <div class="foot">Added funds ${paise(b.funds)} · Earnings ${paise(b.earnings)}</div>
      </div>
      <div class="panel kpi">
        <div class="lbl lbl-start">${w.broker ? brokerMark(w.broker.broker, w.broker.label) : ''}${w.broker?.label || 'Broker'} available margin</div>
        <div class="val val-ic">${icon('wallet')}${f?.available != null ? inr(f.available, { dp: 2 }) : w.broker?.available != null ? inr(w.broker.available, { dp: 2 }) : '–'}</div>
        <div class="foot">${w.broker ? `Your trading money stays with ${w.broker.label}. TradeLock never moves it.` : 'Connect a broker to see your margin.'}</div>
      </div>
    </div>`;
}

function addPanel(ctx) {
  const w = ctx.data, ui = ctx.ui;
  const provider = w.provider;
  return html`
    <div class="panel pad" id="sec-add">
      <div class="panel-head"><h3 class="panel-title">${icon('plus')} Add balance</h3>
        ${provider === 'razorpay' ? pill('UPI · Cards · Netbanking', 'grey', { sm: true }) : provider === 'simulated' ? pill('Test mode', 'amber', { sm: true }) : ''}</div>
      ${provider ? html`
        <div class="chips">${CHIPS.map(a => html`<button type="button" class="chip ${Number(ui.amount) === a ? 'on' : ''}" data-chip="${a}">${inr(a)}</button>`)}</div>
        <div class="field mt-s"><label for="add-amount">Amount</label>
          <div class="input-wrap"><span class="affix">₹</span><input class="input" id="add-amount" inputmode="numeric" value="${ui.amount ?? 1000}"></div>
          <span class="tiny dim">${inr(w.limits.minTopup / 100)} to ${inr(w.limits.maxTopup / 100)} at a time. Added funds pay for TradeLock only and can't be withdrawn.</span></div>
        ${formError(ui.addError)}
        <button class="btn btn-primary btn-block mt" id="add-go">${icon('wallet')}Add ${inr(Number(ui.amount ?? 1000) || 0)}</button>
        ${provider === 'simulated' ? html`<p class="tiny dim">Test mode: no real payment is taken. Live payments start once Razorpay keys are added on the server.</p>` : ''}`
      : html`<p class="muted" style="margin:0">Online payments are not set up yet. Your trial keeps running in the meantime.</p>`}
    </div>`;
}

function withdrawPanel(ctx) {
  const w = ctx.data, ui = ctx.ui;
  ui.method ??= 'upi';
  const can = w.balances.total >= w.limits.minWithdraw;
  return html`
    <div class="panel pad wd-panel" id="sec-withdraw">
      <div class="panel-head"><h3 class="panel-title">${icon('bank')} Withdraw wallet balance</h3><span class="muted small">Available ${paise(w.balances.total)}</span></div>
        <div class="field"><label for="wd-amount">Amount</label>
          <div class="input-wrap"><span class="affix">₹</span><input class="input" id="wd-amount" inputmode="decimal" value="${ui.wdAmount ?? Math.floor(w.balances.total / 100)}" ${can ? '' : 'disabled'}></div></div>
        <span class="tiny dim">Minimum withdrawal ${paise(w.limits.minWithdraw)}.</span>
        <div class="seg mt-s" role="group" aria-label="Withdraw to">
          <button type="button" data-method="upi" aria-pressed="${ui.method === 'upi'}">UPI</button>
          <button type="button" data-method="bank" aria-pressed="${ui.method === 'bank'}">Bank transfer</button>
        </div>
        ${ui.method === 'upi'
          ? html`<div class="field mt-s"><label for="wd-upi">UPI ID</label><input class="input" id="wd-upi" placeholder="name@okhdfcbank" autocomplete="off" value="${ui.upi || ''}"></div>`
          : html`<div class="form-grid mt-s">
              <div class="field full"><label for="wd-name">Account holder name</label><input class="input" id="wd-name" autocomplete="name" value="${ui.name || ''}"></div>
              <div class="field"><label for="wd-account">Account number</label><input class="input num" id="wd-account" inputmode="numeric" autocomplete="off" value="${ui.account || ''}"></div>
              <div class="field"><label for="wd-ifsc">IFSC</label><input class="input num" id="wd-ifsc" autocomplete="off" value="${ui.ifsc || ''}" placeholder="HDFC0001234"></div>
            </div>`}
        ${ctx.state.user.mfaEnabled ? html`<div class="field mt-s"><label for="wd-code">Authenticator code</label><input class="input num" id="wd-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>` : ''}
        ${formError(ui.wdError)}
        <div class="wd-foot">
          <button class="btn btn-primary btn-block" id="wd-go" ${can ? '' : 'disabled'}>${icon('bank')}${can ? 'Withdraw' : `Withdraw · needs ${paise(w.limits.minWithdraw)} balance`}</button>
          <p class="tiny dim" style="margin:8px 0 0">${can
            ? `Minimum ${paise(w.limits.minWithdraw)}. Sent within 2 working days. Added funds and referral earnings are both withdrawable.`
            : html`Earn ${paise(w.plan.commission)} every time a trader you referred pays. Share your link from the <a href="/affiliate">Affiliate hub</a>.`}</p>
        </div>
    </div>`;
}

function activityPanel(ctx) {
  const w = ctx.data;
  const walletActivity = w.ledger.filter(l => !['withdrawal', 'withdrawal_reversal'].includes(l.type));
  return html`
    <div class="panel pad">
      <div class="panel-head"><h3 class="panel-title">${icon('list')} Transaction history</h3><span class="muted small">Top-ups, subscription payments, commissions and withdrawals</span></div>
      ${w.withdrawals.map(x => html`
        <div class="txn"><div class="grow"><b>Withdrawal to ${x.method === 'upi' ? x.destination : x.destination.replace(/\d(?=\d{4})/g, '•')}</b><span>${dateIST(x.createdAt)} · ${hmIST(x.createdAt)}${x.note ? ` · Ref: ${x.note}` : ''}</span></div>
          ${pill(...STATUS[x.status], { sm: true })}<b class="num">−${paise(x.amount)}</b></div>`)}
      ${walletActivity.length ? walletActivity.map(l => {
        const [label, tone] = TYPE[l.type] || [l.type, ''];
        return html`<div class="txn"><div class="grow"><b>${label}</b><span>${l.note} · ${ago(l.createdAt)}</span></div>
          <span class="pill grey sm">${l.bucket === 'funds' ? 'Funds' : 'Earnings'}</span><b class="num ${l.amount > 0 ? 'pos' : ''}">${l.amount > 0 ? '+' : '−'}${paise(Math.abs(l.amount))}</b></div>`;
      }) : !w.withdrawals.length ? empty('wallet', 'No transactions yet', 'Top-ups, subscription payments, commissions and withdrawals will appear here.') : ''}
    </div>`;
}

/** Paper wallet: the money Algo Trading uses in Paper mode. Any amount from ₹10,000 to ₹1 crore, or reset to ₹10 lakh. */
function paperPanel(ctx) {
  const p = ctx.data.paper, paperOn = !!ctx.state.dash?.broker?.paperMode;
  const change = p.balance - p.startBalance;
  return html`
    <section class="panel pad mt paper-wallet" id="sec-paper">
      <div class="paper-wallet-head">
        <div>
          <h3 class="panel-title">${icon('wallet')} Paper wallet ${pill(paperOn ? 'Paper trading on' : 'Not in use', paperOn ? 'ice' : 'grey', { sm: true })}</h3>
          <div class="paper-wallet-bal"><b class="num">${inr(p.balance)}</b>
            <small class="${change > 0 ? 'pos' : change < 0 ? 'neg' : 'muted'}">${change ? `${change > 0 ? '+' : '−'}${inr(Math.abs(change))} since set to ${inr(p.startBalance)}` : `set to ${inr(p.startBalance)}`}</small></div>
          <p class="muted small">Pretend money for Paper mode on the AI Algo Trading page: trades fill at live Dhan prices and the P&amp;L (after charges) lands here. It is not real money and can't be withdrawn.</p>
        </div>
        <div class="paper-wallet-set">
          <label class="muted small" for="paper-amount">Set balance (₹10,000 – ₹1 crore)</label>
          <div class="input-wrap"><span class="affix">₹</span><input class="input num" id="paper-amount" inputmode="numeric" value="${Math.round(p.balance)}" aria-label="Paper wallet balance"></div>
          <div class="paper-wallet-btns">
            <button class="btn btn-primary btn-sm" type="button" id="paper-set">Set balance</button>
            <button class="btn btn-ghost btn-sm" type="button" id="paper-reset">Reset to ${inr(p.default)}</button>
          </div>
        </div>
      </div>
    </section>`;
}

export default {
  title: 'Wallet',
  sub: 'Add or withdraw balance and see every transaction',
  layout: 'app',
  auth: true,

  async load(ctx) {
    const [w, paper] = await Promise.all([get('/wallet'), get('/paper/wallet').catch(() => null)]);
    store.set({ wallet: w.balances });
    return { ...w, paper };
  },

  view(ctx) {
    return html`
      ${balanceCards(ctx.data, ctx.state.dash)}
      ${ctx.data.paper ? paperPanel(ctx) : ''}
      <div class="halves fill mt">${addPanel(ctx)}${withdrawPanel(ctx)}</div>
      <div class="mt">${activityPanel(ctx)}</div>`;
  },

  draw(ctx) {
    const section = window.__walletSection;
    if (section) { window.__walletSection = null; document.getElementById(`sec-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  },

  onStore(ctx, patch) {
    if (patch.wallet && patch.wallet.total !== ctx.data.balances.total) ctx.reload().catch(() => {});
  },

  mount(ctx) {
    const { el, signal, ui } = ctx;
    const keep = () => {
      for (const [k, id] of [['amount', 'add-amount'], ['wdAmount', 'wd-amount'], ['upi', 'wd-upi'], ['name', 'wd-name'], ['account', 'wd-account'], ['ifsc', 'wd-ifsc']]) {
        const i = $(`#${id}`, el);
        if (i) ui[k] = i.value;
      }
    };
    on(el, 'click', '[data-chip]', (_, b) => { keep(); ui.amount = b.dataset.chip; ctx.paint(); $('#sec-add', el)?.scrollIntoView({ behavior: 'smooth' }); }, signal);
    on(el, 'input', '#add-amount', (_, i) => { const b = $('#add-go', el); if (b) b.lastChild.textContent = `Add ${inr(Number(i.value.replace(/[^\d.]/g, '')) || 0)}`; }, signal);
    on(el, 'click', '[data-method]', (_, b) => { keep(); ui.method = b.dataset.method; ui.wdError = null; ctx.paint(); }, signal);

    on(el, 'click', '#add-go', async (_, b) => {
      keep();
      b.disabled = true;
      ui.addError = null;
      try {
        const order = await post('/wallet/topup', { amount: Number(String(ui.amount).replace(/[^\d.]/g, '')) });
        if (order.provider === 'razorpay') await payAndVerify(post, order, 'Wallet top-up');
        toast(`${paise(order.amount)} added to your wallet.`);
        await ctx.reload();
      } catch (e) {
        ui.addError = e.message;
        ctx.paint();
      }
    }, signal);

    on(el, 'click', '#paper-set', async (_, b) => {
      const amount = Number(String($('#paper-amount', el)?.value || '').replace(/[^\d.]/g, ''));
      b.disabled = true;
      try { await put('/paper/wallet', { balance: amount }); toast(`Paper wallet set to ${inr(amount)}.`, 'ok'); await ctx.reload(); }
      catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }, signal);
    on(el, 'click', '#paper-reset', async (_, b) => {
      b.disabled = true;
      try { await post('/paper/wallet/reset'); toast(`Paper wallet reset to ${inr(ctx.data.paper.default)}.`, 'ok'); await ctx.reload(); }
      catch (e) { toast(e.message, 'error'); b.disabled = false; }
    }, signal);

    on(el, 'click', '#wd-go', async (_, b) => {
      keep();
      b.disabled = true;
      ui.wdError = null;
      try {
        await post('/wallet/withdraw', {
          amount: Number(String(ui.wdAmount).replace(/[^\d.]/g, '')), method: ui.method,
          upi: ui.upi, name: ui.name, account: ui.account, ifsc: ui.ifsc, code: $('#wd-code', el)?.value,
        });
        toast('Withdrawal requested. We will notify you when it is paid.');
        Object.assign(ui, { wdAmount: undefined, account: '', ifsc: '' });
        await ctx.reload();
      } catch (e) { ui.wdError = e.message; ctx.paint(); }
    }, signal);
  },
};
