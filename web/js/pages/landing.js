import { html } from '../core/dom.js';
import { icon, logoMark } from '../ui/icons.js';
import { lineChart, ring } from '../ui/charts.js';
import { pill, brokerLogo } from '../ui/parts.js';

// Sample curve for the hero card (clearly labelled as sample data).
const SAMPLE = [[0, 0], [68, 0], [75, -420], [89, -1180], [97, -300], [103, 1400], [108, 2650], [113, 3480], [180, 3480], [187, 3210], [195, 3620], [203, 3390], [213, 3450]];

const nav = user => html`
  <nav class="nav">
    <a class="logo" href="/">${logoMark()}<span>TRADE<b>LOCK</b></span></a>
    <div class="nav-links">
      <a class="hide-sm" href="/" data-scroll="features">Features</a>
      <a class="hide-sm" href="/" data-scroll="how">How it works</a>
      <a class="hide-sm" href="/" data-scroll="pricing">Pricing</a>
      <a class="hide-sm" href="/" data-scroll="faq">FAQ</a>
      ${user
        ? html`<a class="btn btn-primary btn-sm" href="/overview">Open dashboard</a>`
        : html`<a href="/android">Android app</a><a href="/login">Log in</a><a class="btn btn-primary btn-sm" href="/signup">Start free trial</a>`}
    </div>
  </nav>`;

// The six protection rules (all switchable, all set by the trader).
const RULES = [
  ['octagon', 'Daily stop-loss', 'Set a maximum loss for the day as a % of capital or a fixed ₹ amount. Hit it and the day is over.'],
  ['chart', 'Profit target', 'Lock in a good day: once profit reaches your target, TradeLock books it and stops further trading.'],
  ['list', 'Trades per day', 'Cap the number of entries. No more revenge trades after your planned setups are done.'],
  ['alert', 'Losing-streak stop', 'Stop for the day after a set number of losses in a row, before tilt takes over.'],
  ['gauge', 'Profit give-back', 'Once you are well in profit, exit if too much of the peak is handed back to the market.'],
  ['clock', 'Cutoff time', 'No new trades after the time you choose, so the last hour does not undo the morning.'],
];

const ENFORCE = [
  ['power', 'Automatic square-off', 'When a rule is hit, pending orders are cancelled and open positions are closed at market on your Dhan account.'],
  ['lock', 'Dhan kill switch, locked for the day', 'TradeLock switches on Dhan\'s own kill switch twice, so it cannot be turned off again until the next trading day, not even from the Dhan app.'],
  ['shield', 'One-tap manual kill switch', 'Feeling it slip? One tap closes everything and locks your Dhan account for the rest of the day.'],
  ['sliders', 'Rules that apply instantly', 'Change any rule at any time, even mid-session, and it applies at once. A limit already hit today stays hit until the next trading day.'],
];

const SEE = [
  ['grid', 'Live dashboard', 'Today\'s P&L, margin and an intraday chart with your stop-loss, target and cutoff drawn on it, updated every few seconds.'],
  ['calendar', 'P&L calendar from Dhan', 'Every trading day in green or red, built from your Dhan trade history, net of brokerage, taxes and charges.'],
  ['chart', 'Performance analytics', 'Win rate, rule adherence, equity curve and your worst days, so you can see what discipline is worth.'],
  ['list', 'Positions with one-tap close', 'All open positions and pending orders in one place. Close or cancel any of them in a single tap.'],
  ['bell', 'Instant alerts', 'Warnings before a limit is reached, alerts when it is crossed, and a full record of every action taken.'],
  ['key', 'Token renewed for you', 'Your Dhan access token is renewed automatically twice a day, so protection does not lapse overnight.'],
];

const FLOW = [
  ['Rule crossed', 'Your P&L, trade count or the clock crosses a limit you set.'],
  ['Positions closed', 'Pending orders are cancelled and open positions are squared off at market.'],
  ['Dhan account locked', 'The Dhan kill switch is switched on and locked until the next trading day.'],
  ['You are notified', 'You get an alert with what happened and why. Tomorrow starts fresh.'],
];

const FAQ = [
  ['Does TradeLock trade for me?', 'No. TradeLock never opens trades or gives tips. It only watches your account and, when one of your own rules is hit, closes positions and locks your Dhan account for the day.'],
  ['Which brokers are supported?', 'Dhan today. Zerodha, Upstox, Angel One and StoxKart are coming soon.'],
  ['Can I switch the kill switch off the same day?', 'No, by design. Once it is on, your Dhan account stays locked until the next trading day. That is what stops the "one more trade" that turns a bad day into a disaster.'],
  ['What does TradeLock need from my Dhan account?', 'Your Dhan client ID and an access token from web.dhan.co. For automatic square-off, add TradeLock\'s server IP as a static IP in Dhan (we show you how). We never ask for your Dhan password, PIN or TOTP.'],
  ['What happens when my Dhan token expires?', 'TradeLock renews it automatically twice a day while it is still valid. If it ever expires, you get an alert to reconnect with a fresh token.'],
  ['Is there a free trial? How do I pay?', 'Every new trader gets a free trial (one per person). After that it is a simple monthly payment by UPI, card or netbanking. No auto-debit, cancel any time by simply not renewing.'],
];

const card = ([ic, title, body]) => html`<div class="panel card3 lp-card"><div class="ico-tile">${icon(ic)}</div><h3>${title}</h3><p>${body}</p></div>`;

export default {
  title: 'Trade with rules',
  layout: 'bare',

  view(ctx) {
    const { user, meta } = ctx.state;
    const plan = meta?.plan || { priceInr: 499, trialDays: 7 };
    const commission = Math.round(plan.priceInr * 0.2 * 100) / 100;
    return html`
    <div class="wrap">
      ${nav(user)}
      <header class="hero">
        <div>
          ${pill('Risk protection for Dhan traders', '', { dot: true })}
          <h1>Trade with rules.<span>Not emotions.</span></h1>
          <p class="lead">TradeLock watches your Dhan account live and enforces the limits you set: daily stop-loss, profit target, trades per day and cutoff time. When a limit is hit, it closes your positions and locks your Dhan account for the day.</p>
          <div class="row">
            <a class="btn btn-primary btn-lg" href="/signup">Start ${plan.trialDays}-day free trial ${icon('arrow')}</a>
            <a class="btn btn-lg" href="/login">${meta?.demo ? 'Try the demo account' : 'Log in'}</a>
          </div>
          <div class="lp-trust">
            <span>${icon('check')}₹${plan.priceInr}/month</span>
            <span>${icon('check')}No auto-debit</span>
            <span>${icon('check')}Web &amp; Android app</span>
          </div>
        </div>
        <div class="panel demo-card">
          <div class="row between">${pill('Sample data', 'ice', { dot: true, pulse: true })}<span class="clock">NSE · 12:48 IST</span></div>
          <div class="demo-stats">
            <div>
              <div class="eyebrow">Today's P&amp;L</div>
              <div class="big pos">+₹3,450</div>
              <div class="muted small">Realized ₹3,480 · Open −₹30</div>
            </div>
            <div class="ring" id="hero-ring"><svg viewBox="0 0 100 100"></svg><div class="ring-label"><div><b>2/3</b><small>Trades</small></div></div></div>
          </div>
          <svg class="demo-spark" id="hero-spark" aria-hidden="true"></svg>
          <div class="well stack">
            <div class="row between small"><span class="muted">Daily stop-loss used</span><span class="num">₹1,180 / ₹5,000</span></div>
            <div class="meter"><i style="width:23.6%"></i></div>
            <div class="row between small"><span class="muted">Profit target ₹8,000</span><span class="num pos">43%</span></div>
          </div>
          <div class="lp-ks">
            <span class="lp-ks-logo">${brokerLogo('dhan', 'Dhan')}</span>
            <div class="grow"><b>Dhan kill switch</b><span class="muted small">Arms automatically when a limit is hit</span></div>
            ${pill('Armed', '', { dot: true, sm: true })}
          </div>
        </div>
      </header>

      <section class="lp-stats">
        <div><b>6</b><span>protection rules</span></div>
        <div><b>Live</b><span>position checks every few seconds</span></div>
        <div><b>1 tap</b><span>to close all &amp; lock Dhan</span></div>
        <div><b>2×</b><span>daily automatic token renewal</span></div>
      </section>

      <section class="section" id="features">
        <span class="eyebrow">Protection rules</span>
        <h2>Six rules that stop a bad day getting worse</h2>
        <p class="sub">Set your limits before the market opens. Switch each one on or off, as a % of capital or a fixed amount. TradeLock checks them against your live Dhan positions all session.</p>
        <div class="cards3">${RULES.map(card)}</div>
      </section>

      <section class="section">
        <span class="eyebrow">Enforcement</span>
        <h2>It doesn't just warn you. It acts.</h2>
        <p class="sub">Most tools stop at an alert. TradeLock closes the positions and locks the account, because in the moment, willpower is the first thing to go.</p>
        <div class="lp-grid2">${ENFORCE.map(card)}</div>
      </section>

      <section class="section">
        <span class="eyebrow">When a limit is hit</span>
        <h2>What happens, in seconds</h2>
        <ol class="lp-flow">
          ${FLOW.map(([t, d], i) => html`<li><span class="lp-step">${i + 1}</span><div><b>${t}</b><p>${d}</p></div></li>`)}
        </ol>
      </section>

      <section class="section">
        <span class="eyebrow">See everything</span>
        <h2>Your trading, clearly</h2>
        <p class="sub">Everything you need to trade with a plan and review it honestly afterwards, on the web and in the Android app.</p>
        <div class="cards3">${SEE.map(card)}</div>
      </section>

      <section class="section" id="how">
        <span class="eyebrow">How it works</span>
        <h2>Protected in three steps</h2>
        <div class="cards3">
          <div class="panel card3"><span class="n">STEP 1</span><h3>Sign up</h3><p>Continue with Google or email. Your free trial starts right away.</p></div>
          <div class="panel card3"><span class="n">STEP 2</span><h3>Connect Dhan</h3><p>Paste your Dhan client ID and access token, and add TradeLock's static IP in Dhan so exits can be placed. We guide you through it.</p></div>
          <div class="panel card3"><span class="n">STEP 3</span><h3>Set your rules</h3><p>Pick your stop-loss, profit target, trade cap and cutoff. From then on, TradeLock holds you to them.</p></div>
        </div>
      </section>

      <section class="section lp-split">
        <div>
          <span class="eyebrow">Security &amp; honesty</span>
          <h2>Built to be trusted with your account</h2>
          <ul class="lp-checks">
            <li>${icon('check')}<span><b>We never ask for your Dhan password, PIN or TOTP.</b> Only an access token, encrypted at rest.</span></li>
            <li>${icon('check')}<span><b>No tips, no trading on your behalf.</b> TradeLock only closes positions when your own rule says so.</span></li>
            <li>${icon('check')}<span><b>Your money stays with Dhan.</b> TradeLock never holds your trading funds.</span></li>
            <li>${icon('check')}<span><b>Every action is recorded.</b> See exactly what was done, when and why.</span></li>
          </ul>
        </div>
        <div class="panel pad lp-brokers">
          <span class="eyebrow">Brokers</span>
          <div class="lp-broker on">${brokerLogo('dhan', 'Dhan')}<b>Dhan</b>${pill('Available', '', { sm: true })}</div>
          <div class="lp-broker">${brokerLogo('zerodha', 'Zerodha', { off: true })}<b>Zerodha</b>${pill('Coming soon', 'amber', { sm: true })}</div>
          <div class="lp-broker">${brokerLogo('upstox', 'Upstox', { off: true })}<b>Upstox</b>${pill('Coming soon', 'amber', { sm: true })}</div>
          <div class="lp-broker">${brokerLogo('angelone', 'Angel One', { off: true })}<b>Angel One</b>${pill('Coming soon', 'amber', { sm: true })}</div>
          <div class="lp-broker">${brokerLogo('stoxkart', 'StoxKart', { off: true })}<b>StoxKart</b>${pill('Coming soon', 'amber', { sm: true })}</div>
        </div>
      </section>

      <section class="section" id="pricing">
        <span class="eyebrow">Pricing</span>
        <h2>One plan. Everything included.</h2>
        <div class="panel lp-price">
          <div class="lp-price-main">
            <span class="eyebrow">TradeLock Pro</span>
            <div class="row mt-s"><span class="big">₹${plan.priceInr}</span><span class="muted">/ month + GST</span></div>
            <p class="muted">${plan.trialDays}-day free trial. Pay month by month by UPI, card or netbanking. No auto-debit.</p>
            <a class="btn btn-primary btn-lg" href="/signup">Start free trial ${icon('arrow')}</a>
          </div>
          <ul class="lp-checks lp-price-list">
            <li>${icon('check')}<span>All six protection rules</span></li>
            <li>${icon('check')}<span>Automatic square-off &amp; Dhan kill switch</span></li>
            <li>${icon('check')}<span>Live dashboard, P&amp;L calendar &amp; analytics</span></li>
            <li>${icon('check')}<span>Alerts and a full action history</span></li>
            <li>${icon('check')}<span>Automatic Dhan token renewal</span></li>
            <li>${icon('check')}<span>Web and Android app</span></li>
          </ul>
        </div>
        <div class="panel lp-refer">
          <div class="ico-tile">${icon('share')}</div>
          <div class="grow"><b>Refer &amp; earn ${Math.round(0.2 * 100)}% every month.</b> <span class="muted">Invite traders with your link and earn ₹${commission.toFixed(2)} each time they pay, credited to your TradeLock wallet.</span></div>
          <a class="btn btn-sm" href="/signup">Get your link</a>
        </div>
      </section>

      <section class="section" id="faq">
        <span class="eyebrow">FAQ</span>
        <h2>Questions traders ask</h2>
        <div class="lp-faq">
          ${FAQ.map(([q, a]) => html`<details class="panel"><summary>${q}${icon('plus')}</summary><p>${a}</p></details>`)}
        </div>
      </section>

      <section class="section">
        <div class="panel lp-cta">
          <h2>Your next red day can stop at your limit.</h2>
          <p class="muted">Set the rules today. Let TradeLock hold you to them tomorrow.</p>
          <a class="btn btn-primary btn-lg" href="/signup">Start ${plan.trialDays}-day free trial ${icon('arrow')}</a>
          <p class="fineprint">${icon('shield')}Built for discipline. Not a promise of profit.</p>
        </div>
      </section>

      <footer class="footer">
        <span class="logo" style="font-size:15px">TRADE<b>LOCK</b></span>
        <span>Trading in derivatives carries risk. TradeLock is a discipline tool, not investment advice.</span>
        <span class="row"><a href="/android">Android app</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a><a href="/refund">Refunds</a><a href="/contact">Contact</a><span>© 2026 Nexlogic LLP</span></span>
      </footer>
    </div>`;
  },

  draw() {
    const spark = document.getElementById('hero-spark');
    if (spark) lineChart(spark, SAMPLE, { bare: true, yDomain: [-1500, 4000] });
    const r = document.getElementById('hero-ring');
    if (r) ring(r, 2 / 3);
  },

  mount(ctx) {
    ctx.el.addEventListener('click', e => {
      const a = e.target.closest('[data-scroll]');
      if (!a) return;
      e.preventDefault();
      document.getElementById(a.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' });
    }, { signal: ctx.signal });
  },
};
