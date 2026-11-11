/** Shared, safe-to-display application error. */
export class TTError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'TTError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
  }
}

export function normalizeError(error) {
  if (error instanceof TTError) return error;
  const code = String(error?.code || 'internal');
  const message = typeof error?.message === 'string' ? error.message : 'حدث خطأ غير متوقع. حاول مرة أخرى.';
  return new TTError(code, message, { cause: error, retryable: /network|timeout|unavailable|internal/i.test(code) });
}
