import { bad } from './errors.js';

const fail = (field, message) => { throw bad('VALIDATION', message, { field }); };

export const v = {
  str(x, field, { min = 0, max = 500 } = {}) {
    if (typeof x !== 'string') fail(field, `${field} is required`);
    const s = x.trim();
    if (s.length < min || s.length > max) fail(field, `${field} must be ${min}–${max} characters`);
    return s;
  },
  email(x) {
    const s = v.str(x, 'Email', { min: 3, max: 254 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail('email', 'Enter a valid email address');
    return s;
  },
  num(x, field, { min, max, int = false }) {
    const n = typeof x === 'string' ? Number(x.replace(/[,\s₹]/g, '')) : x;
    if (typeof n !== 'number' || !Number.isFinite(n) || (int && !Number.isInteger(n)) || n < min || n > max) {
      fail(field, `${field} must be ${int ? 'a whole number' : 'a number'} from ${min.toLocaleString('en-IN')} to ${max.toLocaleString('en-IN')}`);
    }
    return n;
  },
  bool(x, field) {
    if (typeof x !== 'boolean') fail(field, `${field} must be true or false`);
    return x;
  },
  oneOf(x, field, list) {
    if (!list.includes(x)) fail(field, `${field} must be one of: ${list.join(', ')}`);
    return x;
  },
  time(x, field) {
    if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) fail(field, `${field} must be a time like 15:00`);
    return x;
  },
};
