import { z } from 'zod';

/**
 * Error returned to clients as { error: { code, message } }. The code is
 * stable and is what the app translates; the message is for developers.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const badRequest = (code = 'invalid_input', msg?: string) => new AppError(400, code, msg);
export const unauthorized = (code = 'unauthenticated') => new AppError(401, code);
export const forbidden = (code = 'forbidden', msg?: string) => new AppError(403, code, msg);
// Used instead of 403 when revealing that a resource exists would leak information.
export const notFound = (code = 'not_found') => new AppError(404, code);
export const conflict = (code: string, msg?: string) => new AppError(409, code, msg);
export const tooMany = (code = 'rate_limited') => new AppError(429, code);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const res = schema.safeParse(data ?? {});
  if (!res.success) {
    const first = res.error.issues[0];
    throw badRequest('invalid_input', first ? `${first.path.join('.')}: ${first.message}` : undefined);
  }
  return res.data;
}
