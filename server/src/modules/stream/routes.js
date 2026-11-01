// Server-Sent Events: one long-lived response per open tab, pushed from the in-process bus.
import { subscribe } from '../../lib/bus.js';
import { sseOpened, sseClosed } from '../../lib/metrics.js';
import { getDashboard } from '../risk/service.js';
import { unreadCount } from '../notifications/service.js';
import { latestEmergency } from '../emergency/service.js';

export function streamRoutes(r) {
  r.get('/api/stream', ctx => {
    const { req, res, user } = ctx;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: proxies must not compress or buffer the event stream.
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    send('snapshot', getDashboard(user.id));
    send('unread', { count: unreadCount(user.id) });
    send('emergency', latestEmergency(user.id));

    const off = subscribe(user.id, send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    sseOpened();
    req.on('close', () => { off(); clearInterval(heartbeat); sseClosed(); });
  });
}
