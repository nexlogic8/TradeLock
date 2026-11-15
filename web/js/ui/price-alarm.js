// A price alert fired (server alerts/service.js → SSE "alert"): ring on this screen.
//   Browser: an alarm tone (Web Audio, ~6 s), a desktop notification (kept until clicked) and a toast.
//   Android app: its full-screen alarm (TradeLockApp.ringAlarm, app 1.4.15+); the app's background service also rings
//   for it when the app is closed.
import { toast } from './toast.js';

let ctx = null;
function tone(ms = 6000) {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    const start = ctx.currentTime;
    // Two-tone pulses, like an alarm clock: 880 / 1175 Hz, 180 ms on, 120 ms off.
    for (let t = 0, i = 0; t < ms / 1000; t += 0.3, i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'square'; o.frequency.value = i % 2 ? 1175 : 880;
      g.gain.setValueAtTime(0.0001, start + t); g.gain.exponentialRampToValueAtTime(0.18, start + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, start + t + 0.18);
      o.connect(g).connect(ctx.destination); o.start(start + t); o.stop(start + t + 0.2);
    }
  } catch { /* audio blocked until the page was used once */ }
}
// Browsers only allow sound after a click / key on the page: unlock the audio on the first one.
const unlock = () => { try { ctx ||= new (window.AudioContext || window.webkitAudioContext)(); ctx.resume(); } catch { /* none */ } };
if (typeof window !== 'undefined') { window.addEventListener('pointerdown', unlock, { once: true, capture: true }); window.addEventListener('keydown', unlock, { once: true, capture: true }); }

const fired = new Set();
export function ringPriceAlert(a) {
  if (!a || fired.has(a.id)) return;
  fired.add(a.id);
  const title = `Price alert · ${a.symbol}`, body = `${a.dir === 'below' ? 'Fell to' : 'Reached'} ${a.price} (traded ${a.triggeredPrice ?? a.price}).`;
  if (window.TradeLockApp?.ringAlarm) { try { window.TradeLockApp.ringAlarm(`PRICE ALERT · ${a.symbol}`, body); } catch { tone(); } }
  else tone();
  toast(`🔔 ${title}: ${body}`, 'warn');
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: `price-alert-${a.id}`, requireInteraction: true, icon: '/icons/icon-192.png' });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch { /* notifications blocked */ }
}
