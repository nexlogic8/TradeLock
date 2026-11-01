import { store } from './store.js';
import { get, post } from './api.js';
import { startStream, stopStream } from './stream.js';
import { navigate } from './router.js';

export function signedIn(user) {
  store.set({ user });
  startStream();
}

export async function signOut() {
  await post('/auth/logout').catch(() => {});
  stopStream();
  store.set({ user: null, dash: null, emergency: null, unread: 0 });
  navigate('landing');
}

export async function refreshUser() {
  const { user } = await get('/auth/me');
  store.set({ user });
  return user;
}

// Any API call that finds the session gone sends the user back to sign-in.
window.addEventListener('tl:unauthenticated', () => {
  if (!store.get().user) return;
  stopStream();
  store.set({ user: null, dash: null });
  navigate('login');
});
