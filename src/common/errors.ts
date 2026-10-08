/**
 * Error classes shared across the application
 *
 * TwoAudienceError: distinct messages for users and administrators
 * ConfigError: validation failure with collected problems
 * NotVisibleError: hides existence information behind a single neutral message
 * ConfigReadOnlyError: thrown when config source is a file and someone tries to write
 */

/**
 * Error with distinct messages for users and administrators
 */
export class TwoAudienceError extends Error {
  readonly publicMessage: string; // Message safe to show the end user

  readonly adminMessage: string; // Full detail for logs or admin UI

  constructor(publicMessage: string, adminMessage: string) {
    super(adminMessage);
    this.name = 'TwoAudienceError';
    this.publicMessage = publicMessage;
    this.adminMessage = adminMessage;
  }
}

/**
 * Configuration validation failure, with one or more problems listed
 */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(message: string, problems: string[] = []) {
    super(problems.length ? `${message}\n  - ${problems.join('\n  - ')}` : message);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Resource is not visible to the caller
 *
 * Defaults to "not found" to avoid leaking whether the resource exists
 */
export class NotVisibleError extends Error {
  constructor(message = 'not found') {
    super(message);
    this.name = 'NotVisibleError';
  }
}

/**
 * Config is stored in a file and cannot be written through the API
 *
 * Tells the user which file to edit, or how to switch to database-authoritative mode
 */
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

/**
 * An error's own sentence, ready to go in brackets after what was being reached for.
 *
 * Every probe on `/-/config` answers in the same shape — what was being reached
 * for, then why it did not answer — and the second half is somebody else's
 * sentence: an SDK's, a socket's. It arrives with a full stop it does not need
 * inside brackets at the end of a line that is not a sentence.
 */
export function reasonOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.trim().replace(/\.$/, '');
}
