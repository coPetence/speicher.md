/** Shared application errors */

import { ConfigProblem, ProblemCode, wordingFor } from './config-problems';

/** Stable error code with failure details in subclass fields */
export class CodedError<C extends string = string> extends Error {
  constructor(
    readonly code: C,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Separate user-safe and admin messages */
export class TwoAudienceError<C extends string = string> extends CodedError<C> {
  readonly publicMessage: string; // User-safe message

  readonly adminMessage: string; // Log and admin details

  constructor(code: C, publicMessage: string, adminMessage: string) {
    super(code, adminMessage);
    this.publicMessage = publicMessage;
    this.adminMessage = adminMessage;
  }
}

/** Config validation error formatted for YAML */
export class ConfigError extends CodedError<ProblemCode> {
  /** Main problem */
  readonly summary: ConfigProblem;
  /** Additional problems */
  readonly issues: ConfigProblem[];

  constructor(summary: ConfigProblem, issues: ConfigProblem[] = []) {
    const lines = issues.map((p) => wordingFor(p, 'yaml'));
    const headline = wordingFor(summary, 'yaml');
    super(summary.code, lines.length ? `${headline}\n  - ${lines.join('\n  - ')}` : headline);
    this.summary = summary;
    this.issues = issues;
  }

  /** Issues formatted for YAML */
  get problems(): string[] {
    return this.issues.map((p) => wordingFor(p, 'yaml'));
  }
}

/** Hides resource existence with a default "not found" message */
export class NotVisibleError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotVisibleError';
  }
}

/** Blocks API writes to file-backed config */
export class ConfigReadOnlyError extends Error {
  constructor(readonly path: string | null) {
    super(
      'instance config is file-authoritative and cannot be written' +
        (path ? `; edit ${path} and restart` : '') +
        '. Set SPEICHER_CONFIG_SOURCE=database to make the database authoritative.',
    );
    this.name = 'ConfigReadOnlyError';
  }
}

/** Trims whitespace and a trailing period for bracketed output */
export function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.trim().replace(/\.$/, '');
}
