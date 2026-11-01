// Branded transactional email: a table-based HTML layout with inline styles (what email clients
// support) plus a matching plain-text version. Used for password resets and admin alerts.
import { config } from '../config.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const C = { ink: '#0B1220', text: '#334155', muted: '#64748B', line: '#E2E8F0', mint: '#14B88A', mintDark: '#0E9F76', bg: '#F1F5F9', head: '#05090F' };
const ACCENT = { info: '#14B88A', warn: '#D97706', critical: '#E11D48' };

/**
 * @param {object} o
 * @param {string} o.title            big heading
 * @param {string} [o.preheader]      inbox preview line
 * @param {string} [o.greeting]       e.g. "Hi Asha,"
 * @param {string[]} [o.paragraphs]
 * @param {{label: string, url: string}} [o.button]
 * @param {string[]} [o.facts]        short lines shown in a box, e.g. "Valid for: 30 minutes"
 * @param {string} [o.note]           small print under a divider (security note)
 * @param {'info'|'warn'|'critical'} [o.tone]
 */
export function renderEmail({ title, preheader = '', greeting = '', paragraphs = [], button, facts = [], note = '', tone = 'info' }) {
  const site = config.publicUrl.replace(/\/$/, '');
  const accent = ACCENT[tone] || ACCENT.info;
  const p = t => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${C.text};">${esc(t)}</p>`;
  const factsBox = facts.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 22px;background:#F8FAFC;border:1px solid ${C.line};border-radius:10px;"><tr><td style="padding:14px 18px;font-size:14px;line-height:22px;color:${C.text};">${facts.map(esc).join('<br>')}</td></tr></table>`
    : '';
  const buttonBlock = button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:10px;background:${C.mint};">
          <a href="${esc(button.url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#02150F;text-decoration:none;border-radius:10px;">${esc(button.label)}</a>
        </td></tr></table>
        <p style="margin:0 0 20px;font-size:13px;line-height:20px;color:${C.muted};">Button not working? Copy this link into your browser:<br><a href="${esc(button.url)}" style="color:${C.mintDark};word-break:break-all;">${esc(button.url)}</a></p>`
    : '';
  const noteBlock = note
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${C.line};"><tr><td style="padding-top:18px;font-size:13px;line-height:20px;color:${C.muted};">${esc(note)}</td></tr></table>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
      <tr><td style="background:${C.head};border-radius:16px 16px 0 0;padding:22px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="vertical-align:middle;"><img src="${site}/icons/email-logo.png" width="34" height="34" alt="" style="display:block;border:0;border-radius:9px;"></td>
          <td style="vertical-align:middle;padding-left:12px;font-size:20px;font-weight:800;letter-spacing:1.5px;color:#FFFFFF;">TRADE<span style="color:#38EBB4;">LOCK</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="height:4px;background:${accent};line-height:4px;font-size:0;">&nbsp;</td></tr>
      <tr><td style="background:#FFFFFF;padding:36px 32px 28px;border-left:1px solid ${C.line};border-right:1px solid ${C.line};">
        <h1 style="margin:0 0 20px;font-size:24px;line-height:32px;font-weight:700;color:${C.ink};">${esc(title)}</h1>
        ${greeting ? p(greeting) : ''}
        ${paragraphs.map(p).join('\n        ')}
        ${factsBox}
        ${buttonBlock}
        ${noteBlock}
      </td></tr>
      <tr><td style="background:#FFFFFF;border:1px solid ${C.line};border-top:0;border-radius:0 0 16px 16px;padding:0 32px 26px;">
        <p style="margin:0;font-size:14px;line-height:22px;color:${C.text};">Trade with rules. Not emotions.<br><strong style="color:${C.ink};">Team TradeLock</strong></p>
      </td></tr>
      <tr><td align="center" style="padding:22px 12px 0;font-size:12px;line-height:18px;color:${C.muted};">
        <a href="${site}" style="color:${C.muted};text-decoration:none;">tradelock.in</a> &nbsp;&middot;&nbsp; <a href="mailto:support@nexlogic.in" style="color:${C.muted};text-decoration:none;">support@nexlogic.in</a> &nbsp;&middot;&nbsp; <a href="${site}/privacy" style="color:${C.muted};text-decoration:none;">Privacy</a><br>
        TradeLock is a product of Nexlogic LLP. Trading in derivatives carries risk; TradeLock is a discipline tool, not investment advice.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  const text = [
    title, '',
    ...(greeting ? [greeting, ''] : []),
    ...paragraphs.flatMap(t => [t, '']),
    ...(facts.length ? [...facts, ''] : []),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    ...(note ? [note, ''] : []),
    'Team TradeLock',
    `${site} · support@nexlogic.in`,
  ].join('\n');
  return { html, text };
}
