// Affiliate hub: share a link, see who joined, and what you earned (credited to the TradeLock wallet).
import { html, $, on } from '../core/dom.js';
import { get } from '../core/api.js';
import { inr, int, paise, dateIST, ago } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { pill, empty } from '../ui/parts.js';
import { toast } from '../ui/toast.js';
import { drawShareCard, cardBlob } from '../ui/sharecard.js';

const STATUS = { active: ['Paying', ''], trial: ['Free trial', 'ice'], cancelled: ['Cancelled', 'grey'], expired: ['Ended', 'grey'] };
const fileDataUrl = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file);
});
// Message sent with the invite card.
const inviteText = (link, code) => [
  'Trade with discipline using TradeLock.',
  '',
  'Set daily loss limits, control overtrading, lock profits and use the emergency kill switch.',
  '',
  `Start your 7-day free trial (no card needed) with referral code ${code}:`,
  '',
  link,
].join('\n');

const cardFile = async card => {
  const blob = await cardBlob(card);
  if (!blob) throw new Error('Image could not be created.');
  return new File([blob], 'tradelock-invite.png', { type: 'image/png' });
};

export default {
  title: 'Affiliate hub',
  sub: 'Invite traders and earn on every subscription they pay',
  layout: 'app',
  auth: true,

  load: () => get('/affiliate'),

  view(ctx) {
    const a = ctx.data;
    const per = a.commissionPerPayment ?? Math.round((ctx.state.meta?.plan?.priceInr ?? 499) * a.rate * 100);
    const pct = Math.round(a.rate * 100);
    const signups = a.activeSubscribers + a.trials;
    return html`
      <div class="panel aff-hero">
        <div class="aff-hero-text">
          <span class="eyebrow">Refer &amp; earn</span>
          <h2>Earn <span class="pos">${paise(per)}</span> every month a trader you invite stays subscribed.</h2>
          <p class="muted">That's ${pct}% of each subscription payment, credited straight to your TradeLock wallet. Withdraw it to UPI or bank, or use it for your own plan.</p>
        </div>
        <div class="aff-share">
          <div class="aff-share-body">
            <label class="eyebrow" for="ref-link">Your referral link</label>
            <div class="aff-link">
              <input class="input num" id="ref-link" readonly value="${a.link}" aria-label="Referral link">
              <button class="btn btn-primary" id="copy">${icon('copy')}Copy</button>
            </div>
            <div class="aff-buttons">
              <button class="btn btn-sm aff-btn aff-wa" type="button" data-share-app="whatsapp">WhatsApp</button>
              <button class="btn btn-sm aff-btn aff-tg" type="button" data-share-app="telegram">Telegram</button>
              <button class="btn btn-sm aff-btn" id="share-native" hidden>${icon('share')}More</button>
            </div>
            <span class="tiny dim">Your invite card with code <b class="num">${a.code}</b> is shared with a short message and your link.</span>
          </div>
        </div>
      </div>

      <div class="kpis mt">
        <div class="panel kpi"><div class="lbl">Link clicks</div><div class="val">${int(a.clicks)}</div><div class="foot">All time</div></div>
        <div class="panel kpi"><div class="lbl">Signed up</div><div class="val">${int(signups)}</div><div class="foot">${a.trials} on free trial</div></div>
        <div class="panel kpi"><div class="lbl">Paying traders</div><div class="val pos">${int(a.activeSubscribers)}</div><div class="foot">≈ ${inr(a.estimatedCommission)} a month for you</div></div>
        <div class="panel kpi"><div class="lbl">Total earned</div><div class="val">${paise(a.walletCredited)}</div><div class="foot"><a href="/wallet">In your wallet →</a></div></div>
      </div>

      <div class="panel pad">
        <h3 class="panel-title" style="margin-bottom:14px">How it works</h3>
        <div class="aff-steps">
          <div class="aff-step"><span class="aff-num">1</span><div><b>Share your invite</b><span>Send the referral card and link through WhatsApp, Telegram or another app.</span></div></div>
          <div class="aff-step"><span class="aff-num">2</span><div><b>They try TradeLock free</b><span>7-day trial, then they subscribe to keep their protection.</span></div></div>
          <div class="aff-step"><span class="aff-num">3</span><div><b>You earn every month</b><span>${paise(per)} lands in your wallet each time they pay.</span></div></div>
        </div>
      </div>

      <div class="halves fill mt">
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('users')} Your referrals</h3><span class="muted small">${signups} joined</span></div>
          ${a.referrals?.length ? a.referrals.map(r => html`
            <div class="txn"><span class="avatar aff-av">${r.name[0]}</span><div class="grow"><b>${r.name}</b><span>Joined ${dateIST(r.joinedAt)}</span></div>
              ${pill(...(STATUS[r.status] || [r.status, 'grey']), { sm: true })}</div>`)
          : empty('users', 'No one yet', 'People who sign up with your link appear here.')}
        </div>
        <div class="panel pad">
          <div class="panel-head"><h3 class="panel-title">${icon('wallet')} Earnings</h3><a class="small" href="/wallet">Withdraw →</a></div>
          ${a.recentCommissions?.length ? a.recentCommissions.map(c => html`
            <div class="txn"><div class="grow"><b>Commission</b><span>${c.note || 'Referral payment'} · ${ago(c.createdAt)}</span></div><b class="num pos">+${paise(c.amount)}</b></div>`)
          : empty('wallet', 'No earnings yet', `You'll earn ${paise(per)} each time someone you invited pays for TradeLock.`)}
        </div>
      </div>

      <p class="tiny dim aff-rules">${icon('info')} ${pct}% of each paid subscription (GST excluded); refunded payments don't count. When you post your link publicly, say that it's a referral link.</p>`;
  },

  mount(ctx) {
    const { el, signal } = ctx;
    const link = () => $('#ref-link', el).value;
    on(el, 'click', '#copy', async () => {
      const input = $('#ref-link', el);
      try { await navigator.clipboard.writeText(input.value); toast('Referral link copied.'); }
      catch { input.select(); toast('Link selected. Press Ctrl+C to copy.', 'warn'); }
    }, signal);
    on(el, 'click', '#ref-link', (_, i) => i.select(), signal);
    // The invite card: drawn once, shown as a preview, attached when sharing.
    const name = ctx.state.user?.name || 'a TradeLock trader';
    const card = drawShareCard({ name, code: ctx.data.code, link: ctx.data.link });
    const download = async () => {
      const file = await cardFile(await card);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file); a.download = file.name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    const WEB = {
      whatsapp: (l, t) => `https://wa.me/?text=${encodeURIComponent(t)}`,
      telegram: (l, t) => `https://t.me/share/url?url=${encodeURIComponent(l)}&text=${encodeURIComponent(t.slice(0, t.lastIndexOf('\n')).trim())}`,
    };
    const makeShare = async app => {
      const file = await cardFile(await card);
      const referralLink = link();
      const text = inviteText(referralLink, ctx.data.code);
      // Android app: native share straight into WhatsApp / Telegram with the image attached.
      if (window.TradeLockApp?.shareReferral) {
        window.TradeLockApp.shareReferral(app || '', await fileDataUrl(file), text);
        return;
      }
      // Phone browsers: the system share sheet carries the image.
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text });
        return;
      }
      // Desktop: save the image, open the app with the link; the user attaches the image.
      await download();
      if (app && WEB[app]) window.open(WEB[app](referralLink, text), '_blank', 'noopener');
      toast('Invite image saved. Attach it to your message.', 'warn');
    };
    on(el, 'click', '[data-share-app]', async (_, b) => {
      b.disabled = true;
      try { await makeShare(b.dataset.shareApp); } catch { toast('Could not open sharing. Please try again.', 'warn'); }
      finally { b.disabled = false; }
    }, signal);
    // Phones: the system share sheet (Instagram, SMS, email...) when the browser supports it.
    const native = $('#share-native', el);
    if (native && navigator.share) native.hidden = false;
    on(el, 'click', '#share-native', () => makeShare(null).catch(() => {}), signal);
    if (window.TradeLockApp?.shareReferral && native) native.hidden = false;
  },
};
