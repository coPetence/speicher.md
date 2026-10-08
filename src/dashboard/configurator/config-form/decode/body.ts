/**
 * Reading a submitted form body.
 *
 * Every decoder reads the body through these two and never indexes it itself, so
 * "not submitted" means one thing everywhere: a string is a value, and anything
 * else is absent.
 */

export type FormBody = Record<string, unknown>;

export function submitted(body: FormBody, name: string): string | undefined {
  const raw = body[name];
  if (typeof raw === 'string') return raw;
  // A checkbox group posts an array when more than one box is ticked; the
  // multi-value fields read `body[name]` themselves, so anything else is absent.
  return undefined;
}

export function submittedList(body: FormBody, name: string): string[] {
  const raw = body[name];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (typeof raw === 'string') return [raw];
  return [];
}
