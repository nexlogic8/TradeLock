// Referral share card: a 1080×1350 PNG drawn on a canvas (WhatsApp / Telegram friendly 4:5).
// Contents: TradeLock brand, headline, key features, who invited you, the referral code and link.

const W = 1080, H = 1350;
const C = { bg: '#05090F', bg2: '#0A1820', panel: '#0E1A26', line: 'rgba(142,172,214,.18)', fg: '#E8EEF6', muted: '#8EA0B8', mint: '#38EBB4', mint2: '#1FC995', ink: '#02150F' };
const FEATURES = [
  ['money', 'Book profit or loss as per your rules'],
  ['shield', 'Protect your capital'],
  ['stop', 'Stop overtrading'],
  ['lock', 'Automatic kill switch'],
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function lockIcon(ctx, x, y, s, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 24, s / 24);
  ctx.strokeStyle = color; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  roundRect(ctx, 5, 11, 14, 10, 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(8, 11); ctx.lineTo(8, 8); ctx.arc(12, 8, 4, Math.PI, 0); ctx.lineTo(16, 11); ctx.stroke();
  ctx.restore();
}

/** Round mint badge with a line icon (money, shield, stop, lock), 52px, top-left at x, y. */
function badge(ctx, x, y, kind) {
  const cx = x + 26, cy = y + 26;
  ctx.save();
  ctx.fillStyle = 'rgba(56,235,180,.14)';
  roundRect(ctx, x, y, 52, 52, 15); ctx.fill();
  ctx.strokeStyle = 'rgba(56,235,180,.35)'; ctx.lineWidth = 1.5; roundRect(ctx, x, y, 52, 52, 15); ctx.stroke();
  ctx.strokeStyle = C.mint; ctx.fillStyle = C.mint; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (kind === 'money') {
    roundRect(ctx, cx - 15, cy - 10, 30, 20, 4); ctx.stroke();
    ctx.font = '700 15px "Geist", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('₹', cx, cy + 1);
  } else if (kind === 'shield') {
    ctx.beginPath();
    ctx.moveTo(cx, cy - 15); ctx.lineTo(cx + 13, cy - 10); ctx.lineTo(cx + 13, cy);
    ctx.quadraticCurveTo(cx + 12, cy + 11, cx, cy + 16); ctx.quadraticCurveTo(cx - 12, cy + 11, cx - 13, cy);
    ctx.lineTo(cx - 13, cy - 10); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 5.5, cy + 0.5); ctx.lineTo(cx - 1, cy + 5); ctx.lineTo(cx + 6, cy - 3.5); ctx.stroke();
  } else if (kind === 'stop') {
    ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 10, cy - 10); ctx.lineTo(cx + 10, cy + 10); ctx.stroke();
  } else {
    roundRect(ctx, cx - 12, cy - 3, 24, 18, 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx - 7, cy - 3); ctx.lineTo(cx - 7, cy - 8); ctx.arc(cx, cy - 8, 7, Math.PI, 0); ctx.lineTo(cx + 7, cy - 3); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy + 6, 2.2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

/** Shrink the font until `text` fits `maxW`. */
function fit(ctx, text, weight, size, family, maxW) {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${family}`; s -= 2; } while (ctx.measureText(text).width > maxW && s > 20);
}

export async function drawShareCard({ name, code, link }) {
  // Canvas text only uses web fonts that are already loaded, so load the ones the card needs.
  try {
    await Promise.all(['700 46px Unbounded', '500 46px Unbounded', '400 30px Geist', '500 30px Geist', '600 30px Geist', '600 60px "Geist Mono"']
      .map(f => document.fonts.load(f)));
  } catch { /* fall back to system fonts */ }
  const display = '"Unbounded", "Geist", system-ui, sans-serif';
  const ui = '"Geist", system-ui, sans-serif';
  const mono = '"Geist Mono", ui-monospace, monospace';
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');

  // Background: deep navy with mint glows and a faint grid.
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, C.bg); bg.addColorStop(1, C.bg2);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  for (const [gx, gy, gr, a] of [[120, 80, 620, .22], [W - 40, H - 260, 560, .14]]) {
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    g.addColorStop(0, `rgba(56,235,180,${a})`); g.addColorStop(1, 'rgba(56,235,180,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  ctx.strokeStyle = 'rgba(142,172,214,.05)'; ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  const L = 84;
  // Brand.
  const tile = ctx.createLinearGradient(L, 84, L + 76, 160);
  tile.addColorStop(0, C.mint); tile.addColorStop(1, '#0FA57A');
  ctx.fillStyle = tile; roundRect(ctx, L, 84, 76, 76, 20); ctx.fill();
  lockIcon(ctx, L + 16, 100, 44, C.ink);
  ctx.textBaseline = 'middle';
  ctx.font = `700 46px ${display}`;
  ctx.fillStyle = C.fg; ctx.fillText('TRADE', L + 100, 124);
  const tw = ctx.measureText('TRADE').width;
  ctx.fillStyle = C.mint; ctx.fillText('LOCK', L + 100 + tw, 124);

  // Headline.
  ctx.textBaseline = 'alphabetic';
  fit(ctx, 'Trade with rules.', 700, 76, display, W - 2 * L);
  ctx.fillStyle = C.fg; ctx.fillText('Trade with rules.', L, 318);
  const hg = ctx.createLinearGradient(L, 0, L + 760, 0);
  hg.addColorStop(0, C.mint); hg.addColorStop(1, '#7CC8FF');
  ctx.fillStyle = hg; ctx.fillText('Not emotions.', L, 418);
  fit(ctx, 'Risk control for your Dhan account.', 500, 36, ui, W - 2 * L);
  ctx.fillStyle = '#C9D4E3';
  ctx.fillText('Risk control for your Dhan account.', L, 486);

  // Features.
  let fy = 532;
  for (const [kind, f] of FEATURES) {
    badge(ctx, L, fy, kind);
    ctx.font = `500 36px ${ui}`; ctx.fillStyle = C.fg; ctx.textBaseline = 'middle';
    ctx.fillText(f, L + 76, fy + 28);
    fy += 78;
  }
  ctx.textBaseline = 'alphabetic';

  // Invite panel.
  const py = 864, ph = 380;
  ctx.fillStyle = 'rgba(14,26,38,.92)'; roundRect(ctx, L - 20, py, W - 2 * (L - 20), ph, 36); ctx.fill();
  ctx.strokeStyle = 'rgba(56,235,180,.35)'; ctx.lineWidth = 2; roundRect(ctx, L - 20, py, W - 2 * (L - 20), ph, 36); ctx.stroke();
  const who = `Invited by ${name}`;
  fit(ctx, who, 600, 34, ui, W - 2 * L - 20);
  ctx.fillStyle = C.fg; ctx.fillText(who, L + 20, py + 72);
  ctx.font = `600 22px ${ui}`; ctx.fillStyle = C.mint;
  ctx.fillText('REFERRAL CODE', L + 20, py + 128);
  // Code box (dashed).
  const bx = L + 20, by = py + 148, bw = W - 2 * L - 40, bh = 112;
  ctx.fillStyle = 'rgba(56,235,180,.08)'; roundRect(ctx, bx, by, bw, bh, 22); ctx.fill();
  ctx.setLineDash([12, 10]); ctx.strokeStyle = 'rgba(56,235,180,.75)'; ctx.lineWidth = 3;
  roundRect(ctx, bx, by, bw, bh, 22); ctx.stroke(); ctx.setLineDash([]);
  fit(ctx, code, 600, 72, mono, bw - 60);
  ctx.fillStyle = C.mint; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(code, bx + bw / 2, by + bh / 2 + 3);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.font = `500 28px ${ui}`; ctx.fillStyle = C.fg;
  ctx.fillText('7-day free trial · No card needed', L + 20, py + 318);
  fit(ctx, link.replace(/^https?:\/\//, ''), 500, 28, mono, W - 2 * L - 20);
  ctx.fillStyle = C.mint; ctx.fillText(link.replace(/^https?:\/\//, ''), L + 20, py + 358);

  // Footer.
  ctx.font = `400 24px ${ui}`; ctx.fillStyle = 'rgba(142,160,184,.75)'; ctx.textAlign = 'center';
  ctx.fillText('Built for discipline. Not a promise of profit.', W / 2, H - 40);
  ctx.textAlign = 'left';
  return cv;
}

export const cardBlob = cv => new Promise(res => cv.toBlob(res, 'image/png'));
