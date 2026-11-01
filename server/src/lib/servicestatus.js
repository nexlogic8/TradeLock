// Health records for background services that run as separate processes (they share the database).
import { stmt } from '../db/index.js';

export function report(name, fields) {
  stmt('INSERT OR IGNORE INTO service_status (name) VALUES (?)').run(name);
  const keys = Object.keys(fields);
  if (!keys.length) return;
  stmt(`UPDATE service_status SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE name = ?`)
    .run(...keys.map(k => (k === 'last_result' && fields[k] != null ? JSON.stringify(fields[k]) : fields[k])), name);
}

export const getStatus = name => {
  const r = stmt('SELECT * FROM service_status WHERE name = ?').get(name);
  return r && { ...r, last_result: r.last_result ? JSON.parse(r.last_result) : null };
};

/** Ask a service to run now (it polls for this flag). */
export const requestRun = name => { report(name, { run_requested: 1 }); };
