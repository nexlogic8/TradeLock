export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (code, message, extra) => new HttpError(400, code, message, extra);
export const notFound = (message = 'Not found') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code, message) => new HttpError(409, code, message);
export const forbidden = (code, message, extra) => new HttpError(403, code, message, extra);
