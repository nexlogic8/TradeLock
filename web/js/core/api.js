export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code;
    this.extra = body?.extra;
  }
}

// Android app: the phone's device ID (survives clearing app data), so one phone gets one free trial.
let device;
function deviceHeader() {
  if (device === undefined) { try { device = window.TradeLockApp?.deviceId?.() || null; } catch { device = null; } }
  return device ? { 'X-TL-Device': device } : {};
}

export async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body && { 'Content-Type': 'application/json' }), ...deviceHeader() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', message: 'Cannot reach TradeLock. Check your connection and try again.' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && data?.code === 'UNAUTHENTICATED') window.dispatchEvent(new Event('tl:unauthenticated'));
    throw new ApiError(res.status, data);
  }
  return data;
}

export const get = path => api(path);
export const post = (path, body = {}) => api(path, { method: 'POST', body });
export const put = (path, body) => api(path, { method: 'PUT', body });
export const patch = (path, body) => api(path, { method: 'PATCH', body });
export const del = path => api(path, { method: 'DELETE' });
