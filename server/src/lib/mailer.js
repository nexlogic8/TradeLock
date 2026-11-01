// Minimal SMTP client (implicit TLS, AUTH LOGIN) for alert emails; no dependency.
// Enabled when SMTP_HOST, SMTP_USER and SMTP_PASS are set (e.g. Hostinger: smtp.hostinger.com:465).
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

export const mailEnabled = () => Boolean(config.smtp.host && config.smtp.user && config.smtp.pass);

const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

/** Send an email (plain text, plus HTML when given). Resolves when the server accepts it; rejects with its reply. */
export function sendMail({ to, subject, text, html }) {
  const { host, port, user, pass, from } = config.smtp;
  const recipients = [].concat(to).filter(Boolean);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    socket.setEncoding('utf8');
    socket.setTimeout(15000, () => socket.destroy(new Error('SMTP timeout')));
    socket.on('error', reject);

    // Collect final reply lines ("250 ok"; continuation lines look like "250-...").
    let buffer = '';
    const replies = [];
    const waiters = [];
    socket.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (/^\d{3}(?: |$)/.test(line)) (waiters.length ? waiters.shift()(line) : replies.push(line));
      }
    });
    const reply = () => new Promise(r => (replies.length ? r(replies.shift()) : waiters.push(r)));
    const step = async (cmd, ok) => {
      if (cmd != null) socket.write(`${cmd}\r\n`);
      const line = await reply();
      if (!ok.includes(Number(line.slice(0, 3)))) throw new Error(`SMTP: ${line}`);
      return line;
    };

    (async () => {
      await step(null, [220]);
      await step(`EHLO ${new URL(config.publicUrl).hostname}`, [250]);
      await step('AUTH LOGIN', [334]);
      await step(b64(user), [334]);
      await step(b64(pass), [235]);
      await step(`MAIL FROM:<${from}>`, [250]);
      for (const r of recipients) await step(`RCPT TO:<${r}>`, [250, 251]);
      await step('DATA', [354]);
      // Plain text, or text + HTML as multipart/alternative. Bodies are base64, so no line needs
      // dot-stuffing and any client decodes them.
      const encoded = s => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');
      const boundary = `tl_${randomBytes(12).toString('hex')}`;
      const headers = [
        `From: "TradeLock" <${from}>`,
        `To: ${recipients.join(', ')}`,
        `Subject: ${encodeHeader(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${randomBytes(12).toString('hex')}@${from.split('@')[1] || host}>`,
        'MIME-Version: 1.0',
      ];
      const part = (type, body) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', encoded(body)];
      const msg = (html
        ? [...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
          `--${boundary}`, ...part('text/plain', text), `--${boundary}`, ...part('text/html', html), `--${boundary}--`]
        : [...headers, ...part('text/plain', text)]
      ).join('\r\n');
      await step(`${msg}\r\n.`, [250]);
      socket.end('QUIT\r\n');
      resolve();
    })().catch(e => { socket.destroy(); reject(e); });
  });
}
