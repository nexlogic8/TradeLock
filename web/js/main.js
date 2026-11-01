import { store } from './core/store.js';
import { get } from './core/api.js';
import { show, currentRoute, migrateHashUrl } from './core/router.js';
import { signedIn } from './core/session.js';
import './core/theme.js';
import { initPullRefresh } from './ui/pullrefresh.js';

async function boot() {
  migrateHashUrl();
  try {
    const [{ user }, meta] = await Promise.all([get('/auth/me'), get('/meta')]);
    store.set({ meta });
    if (user) {
      signedIn(user);
      if (location.search.includes('auth_error')) history.replaceState(null, '', location.pathname);
    }
  } catch {
    // Server unreachable: public pages still render; API calls will show their own errors.
  }
  await show(currentRoute());
}

document.addEventListener('click', e => { if (e.target.closest('[data-reload]')) location.reload(); });
// A page restored from the back/forward cache can be an older build with stale data (seen in the Android app
// after an update): load it fresh instead.
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });

initPullRefresh();
boot();
