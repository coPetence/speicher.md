/*
  A config refusal, asserted by its problem code rather than by its wording

  `expect(() => load(yaml)).toRefuseWith('admins.unknown-group')` passes when the
  thrown ConfigError is that refusal, or lists that problem. With `rejects`, the
  error itself is matched. A failure prints every code and wording that was there,
  so a wrong refusal is still easy to read.

  `toFailWith(code, fields?)` is the same for any CodedError: its code, and the
  facts it carries as fields, such as the argument at fault or an HTTP status.
*/
import { ConfigProblem, ProblemCode, wordingFor } from '../../src/common/config-problems';
import { CodedError, ConfigError } from '../../src/common/errors';

interface RefusalOptions {
  /** The key the problem must be about */
  path?: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toRefuseWith(code: ProblemCode, options?: RefusalOptions): R;
      toFailWith(code: string, fields?: Record<string, unknown>): R;
    }
  }
}

function thrown(received: unknown): unknown {
  if (typeof received !== 'function') return received;
  try {
    (received as () => unknown)();
  } catch (err) {
    return err;
  }
  return undefined;
}

function listed(err: ConfigError): string {
  return [err.summary, ...err.issues]
    .map((p: ConfigProblem) => `  ${p.code}  ${wordingFor(p, 'yaml')}`)
    .join('\n');
}

export function toRefuseWith(
  this: jest.MatcherContext,
  received: unknown,
  code: ProblemCode,
  options: RefusalOptions = {},
): jest.CustomMatcherResult {
  const err = thrown(received);
  const wanted = options.path === undefined ? code : `${code} at ${options.path ?? 'the instance'}`;
  if (!(err instanceof ConfigError)) {
    return {
      pass: false,
      message: () =>
        err === undefined
          ? `expected a refusal with ${wanted}, but nothing was thrown`
          : `expected a refusal with ${wanted}, but got ${String(err)}`,
    };
  }

  const pass = [err.summary, ...err.issues].some(
    (p) => p.code === code && (options.path === undefined || p.path === options.path),
  );
  return {
    pass,
    message: () =>
      `expected a refusal ${pass ? 'without' : 'with'} ${wanted}, and it had:\n${listed(err)}`,
  };
}

/**
 * The ConfigError a call throws, for a test that asserts what a problem names,
 * such as the group a reference meant, rather than which problem it is
 */
export function refusalOf(run: () => unknown): ConfigError {
  const err = thrown(run);
  if (err instanceof ConfigError) return err;
  throw new Error(`expected a ConfigError, but got ${String(err)}`);
}

export function toFailWith(
  this: jest.MatcherContext,
  received: unknown,
  code: string,
  fields: Record<string, unknown> = {},
): jest.CustomMatcherResult {
  const err = thrown(received);
  const wanted = Object.keys(fields).length
    ? `${code} with ${this.utils.printExpected(fields)}`
    : code;
  if (!(err instanceof CodedError)) {
    return {
      pass: false,
      message: () =>
        err === undefined
          ? `expected a failure with ${wanted}, but nothing was thrown`
          : `expected a failure with ${wanted}, but got an error with no code: ${String(err)}`,
    };
  }

  const facts = Object.fromEntries(
    Object.keys(fields).map((key) => [key, (err as unknown as Record<string, unknown>)[key]]),
  );
  const pass = err.code === code && this.equals(facts, fields);
  return {
    pass,
    message: () =>
      `expected a failure ${pass ? 'other than' : 'with'} ${wanted}, and got ${err.code}` +
      (Object.keys(fields).length ? ` with ${this.utils.printReceived(facts)}` : '') +
      `: ${err.message}`,
  };
}

/**
 * The CodedError a call throws, for a test that checks where its message ends up,
 * such as the output of a command, without spelling the message out
 */
export function codedErrorOf(run: () => unknown): CodedError {
  const err = thrown(run);
  if (err instanceof CodedError) return err;
  throw new Error(`expected a CodedError, but got ${String(err)}`);
}
