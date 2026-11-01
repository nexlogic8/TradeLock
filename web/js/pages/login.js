import { html, raw, $, busy } from '../core/dom.js';
import { get, post } from '../core/api.js';
import { signedIn } from '../core/session.js';
import { navigate } from '../core/router.js';
import { icon, logoMark } from '../ui/icons.js';
import { formError } from '../ui/parts.js';

// Errors the Google callback reports back as ?auth_error=… on the redirect.
const AUTH_ERRORS = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_state: 'That sign-in link expired. Please try again.',
  google_failed: 'Google sign-in could not be completed. Please try again.',
  google_unverified: 'Your Google email address is not verified, so it cannot be used to sign in.',
  google_disabled: 'Google sign-in is not available right now. Use email and password instead.',
};

// Official multi-colour "G" mark, as Google's branding guidelines require.
const GOOGLE_G = raw(`<svg viewBox="0 0 48 48" aria-hidden="true" width="18" height="18"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`);

function readAuthError() {
  const code = new URLSearchParams(location.search).get('auth_error');
  if (!code) return null;
  history.replaceState(null, '', location.pathname);
  return AUTH_ERRORS[code] || 'Sign-in failed. Please try again.';
}

const securityPanel = () => html`
  <div class="panel auth-card auth-aside">
    <span class="eyebrow">Security</span>
    <h1 style="font-size:24px;margin-top:8px">Security comes first</h1>
    <div class="sec-list">
      <div class="sec-item"><div class="ico-tile">${icon('key')}</div><div><b>Protected sign-in</b><span>Turn on authenticator-app codes. They are also required to use the kill switch.</span></div></div>
      <div class="sec-item"><div class="ico-tile">${icon('link')}</div><div><b>Broker tokens encrypted</b><span>Your broker access token is stored with AES-256 encryption and never shown back to anyone.</span></div></div>
      <div class="sec-item"><div class="ico-tile">${icon('radar')}</div><div><b>Clear system status</b><span>When monitoring is delayed or degraded, the dashboard tells you right away.</span></div></div>
    </div>
  </div>`;

function mfaView(ctx) {
  return html`
    <div class="panel auth-card">
      <h1>Enter your code</h1>
      <p class="muted">Your account has two-factor sign-in turned on. Enter the 6-digit code from your authenticator app.</p>
      <form class="auth-form" id="mfa-form" novalidate>
        <div class="field"><label for="f-code">Authenticator code</label><input class="input num" id="f-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required autofocus></div>
        ${formError(ctx.ui.error)}
        <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('lock')}Verify and sign in</button>
        <a class="btn btn-ghost btn-block" href="/login">Back to sign in</a>
      </form>
    </div>`;
}

function forgotView(ctx) {
  const { sent, error, values = {} } = ctx.ui;
  return html`
    <div class="panel auth-card">
      <h1>Forgot password?</h1>
      ${sent ? html`
        <div class="banner mt">${icon('check')}<div class="grow"><b>Check your email.</b> If an account exists for <b>${sent}</b>, we've sent a link to reset your password. It works for 30 minutes.</div></div>
        <p class="muted small">No email? Check spam, or try again in a few minutes.</p>
        <a class="btn btn-block" href="/login">Back to sign in</a>`
      : html`
        <p class="muted">Enter your account email and we'll send you a link to set a new password.</p>
        <form class="auth-form" id="forgot-form" novalidate>
          <div class="field"><label for="f-email">Email address</label><input class="input" id="f-email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${values.email || ''}" required autofocus></div>
          ${formError(error)}
          <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('arrow')}Send reset link</button>
          <a class="btn btn-ghost btn-block" href="/login">Back to sign in</a>
          <p class="tiny dim" style="margin:0">Signed up with Google? Just use Continue with Google: no password needed.</p>
        </form>`}
    </div>`;
}

function resetView(ctx) {
  const { done, error } = ctx.ui;
  return html`
    <div class="panel auth-card">
      <h1>Set a new password</h1>
      ${done ? html`
        <div class="banner mt">${icon('check')}<div class="grow"><b>Password updated.</b> Sign in with your new password. You were signed out on all other devices.</div></div>
        <a class="btn btn-primary btn-block btn-lg" href="/login">${icon('lock')}Sign in</a>`
      : html`
        <p class="muted">Choose a new password for your TradeLock account.</p>
        <form class="auth-form" id="reset-form" novalidate>
          <div class="field"><label for="f-pw">New password</label><input class="input" id="f-pw" name="password" type="password" autocomplete="new-password" minlength="8" required autofocus><span class="tiny dim">At least 8 characters.</span></div>
          <div class="field"><label for="f-pw2">Confirm new password</label><input class="input" id="f-pw2" name="confirm" type="password" autocomplete="new-password" minlength="8" required></div>
          ${formError(error)}
          <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('lock')}Save new password</button>
          <a class="btn btn-ghost btn-block" href="/forgot">Request a new link</a>
        </form>`}
    </div>`;
}

function credentialsView(ctx) {
  const signup = ctx.name === 'signup';
  const { mfa, error, values = {} } = ctx.ui;
  const { demo, google } = ctx.state.meta || {};
  return html`
    <div class="panel auth-card">
      <h1>${signup ? 'Create your account' : 'Welcome back'}</h1>
      <p class="muted">${signup ? 'Start a free trial. No card needed.' : 'Sign in to your risk dashboard.'}</p>
      ${google ? html`
        <a class="btn btn-google btn-block btn-lg" href="/api/auth/google">${GOOGLE_G}${signup ? 'Sign up with Google' : 'Continue with Google'}</a>
        <div class="or"><span>or use email</span></div>` : ''}
      <form class="auth-form ${google ? 'tight' : ''}" id="auth-form" novalidate>
        ${signup ? html`<div class="field"><label for="f-name">Your name</label><input class="input" id="f-name" name="name" autocomplete="name" value="${values.name || ''}" required></div>` : ''}
        <div class="field"><label for="f-email">Email address</label><input class="input" id="f-email" name="email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${values.email || ''}" required></div>
        <div class="field"><div class="row between"><label for="f-pw">Password</label>${signup ? '' : html`<a class="small" href="/forgot">Forgot password?</a>`}</div><input class="input" id="f-pw" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" value="${values.password || ''}" required>
          ${signup ? html`<span class="tiny dim">At least 8 characters.</span>` : ''}</div>
        ${signup ? html`<div class="field"><label for="f-ref">Referral code <span class="dim">(optional)</span></label>
          <div class="input-wrap ref-wrap"><span class="affix">${icon('share')}</span><input class="input num" id="f-ref" name="ref" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="32" placeholder="e.g. A6656QC6" value="${values.ref ?? ctx.ui.ref ?? ''}"></div>
          ${ctx.ui.ref && (values.ref ?? ctx.ui.ref) === ctx.ui.ref ? html`<span class="tiny pos">${icon('check')} Referral applied from your invite link</span>` : html`<span class="tiny dim">Got an invite link or code from a friend? Enter it here.</span>`}</div>` : ''}
        ${mfa ? html`<div class="field"><label for="f-code">6-digit code from your authenticator app</label><input class="input num" id="f-code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>` : ''}
        ${formError(error)}
        <button class="btn btn-primary btn-block btn-lg" type="submit">${icon('lock')}${signup ? 'Create account' : 'Sign in securely'}</button>
        ${!signup && demo ? html`<button class="btn btn-block" type="button" id="use-demo">Use the demo account</button>` : ''}
        <div class="row small">
          ${signup ? html`<span class="muted">Already have an account?</span><a href="/login">Sign in</a>` : html`<span class="muted">New to TradeLock?</span><a href="/signup">Create an account</a>`}
        </div>
        <p class="tiny dim" style="margin:0">By continuing you agree to the <a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a>.</p>
      </form>
    </div>`;
}

export default {
  title: 'Sign in',
  layout: 'bare',
  guest: true,

  load(ctx) {
    ctx.ui.error ??= readAuthError();
    return null;
  },

  view(ctx) {
    return html`
    <div class="wrap">
      <nav class="nav"><a class="logo" href="/">${logoMark()}<span>TRADE<b>LOCK</b></span></a></nav>
      <div class="auth-grid">
        ${ctx.name === 'mfa' ? mfaView(ctx) : ctx.name === 'forgot' ? forgotView(ctx) : ctx.name === 'reset' ? resetView(ctx) : credentialsView(ctx)}
        ${securityPanel()}
      </div>
    </div>`;
  },

  mount(ctx) {
    const { el, signal } = ctx;
    const finish = user => { signedIn(user); navigate(user.broker ? 'overview' : 'brokers'); };

    // Referral code: from the invite link (?ref=CODE), else the one remembered from an earlier visit.
    if (ctx.name === 'signup') {
      const fromUrl = new URLSearchParams(location.search).get('ref');
      const apply = code => {
        if (!code || ctx.ui.ref) return;
        ctx.ui.ref = String(code).toUpperCase();
        const input = $('#f-ref', el);
        if (input && !input.value) ctx.paint();
      };
      if (fromUrl) { apply(fromUrl); history.replaceState(null, '', location.pathname); }
      else get('/referral').then(r => apply(r.code)).catch(() => {});
    }
    /** Before Google sign-up: check the typed code and remember it for the server. False = stop. */
    const prepareRef = async () => {
      const input = $('#f-ref', el);
      if (!input) return true;
      try { await post('/referral', { code: input.value.trim() }); return true; }
      catch (err) { ctx.ui = { ...ctx.ui, values: { ...ctx.ui.values, ref: input.value }, error: err.message }; ctx.paint(); $('#f-ref', el)?.focus(); return false; }
    };

    // Inside the TradeLock Android app Google's web sign-in is not allowed, so the app shows the
    // phone's own Google account picker and hands back an ID token.
    if (window.TradeLockApp?.googleSignIn) {
      el.addEventListener('click', async e => {
        const g = e.target.closest('.btn-google');
        if (!g) return;
        e.preventDefault();
        if (!(await prepareRef())) return;
        window.__tlGoogle = async (token, err) => {
          if (err || !token) { ctx.ui.error = err || 'Google sign-in was cancelled.'; ctx.paint(); return; }
          try {
            const r = await post('/auth/google/idtoken', { idToken: token });
            if (r.mfa) return navigate('mfa');
            finish(r.user);
          } catch (ex) { ctx.ui.error = ex.message; ctx.paint(); }
        };
        window.TradeLockApp.googleSignIn();
      }, { signal });
    }

    // Web Google sign-up: remember the referral code first, then go to Google.
    if (!window.TradeLockApp?.googleSignIn) {
      el.addEventListener('click', async e => {
        const g = e.target.closest('.btn-google');
        if (!g || !$('#f-ref', el)) return;
        e.preventDefault();
        if (await prepareRef()) location.href = g.href;
      }, { signal });
    }

    el.addEventListener('click', e => {
      if (!e.target.closest('#use-demo')) return;
      const { email, password } = ctx.state.meta.demo;
      $('#f-email', el).value = email;
      $('#f-pw', el).value = password;
      $('#auth-form', el).requestSubmit();
    }, { signal });

    el.addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('[type="submit"]');
      const body = Object.fromEntries(new FormData(e.target));
      await busy(btn, async () => {
        try {
          if (e.target.id === 'mfa-form') return finish((await post('/auth/mfa/complete', body)).user);
          if (e.target.id === 'forgot-form') {
            await post('/auth/forgot', { email: body.email });
            ctx.ui = { sent: body.email };
            return ctx.paint();
          }
          if (e.target.id === 'reset-form') {
            if (body.password !== body.confirm) throw new Error('The two passwords do not match.');
            await post('/auth/reset', { token: new URLSearchParams(location.search).get('token') || '', password: body.password });
            history.replaceState(null, '', '/reset');   // the link is used up: drop it from the address bar
            ctx.ui = { done: true };
            return ctx.paint();
          }
          finish((await post(ctx.name === 'signup' ? '/auth/signup' : '/auth/login', body)).user);
        } catch (err) {
          if (['forgot-form', 'reset-form'].includes(e.target.id)) { ctx.ui = { values: body, error: err.message }; return ctx.paint(); }
          const needsCode = err.code === 'MFA_REQUIRED';
          ctx.ui = { values: body, mfa: ctx.ui.mfa || needsCode, error: needsCode ? null : err.message };
          ctx.paint();
          $(ctx.ui.mfa && !body.code ? '#f-code' : e.target.id === 'mfa-form' ? '#f-code' : '#f-email', el)?.focus();
        }
      });
    }, { signal });
  },
};
