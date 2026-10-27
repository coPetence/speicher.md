import { CodedError } from '../common/errors';

/** Command-line error codes */
export type UsageCode =
  | 'usage.unknown-action'
  | 'usage.unknown-argument'
  | 'usage.argument-count'
  | 'usage.missing-value'
  | 'usage.invalid-value'
  | 'usage.missing-option'
  | 'usage.conflicting-options';

/** Invalid command line with an optional offending argument */
export class UsageError extends CodedError<UsageCode> {
  constructor(
    code: UsageCode,
    message: string,
    readonly argument: string | null = null,
  ) {
    super(code, message);
  }
}

export interface Command {
  /** One-line usage description */
  readonly summary: string;

  /** Argument placeholder for usage */
  readonly args: string;

  /** Requires an up-to-date database schema */
  readonly needsCurrentSchema: boolean;

  /** Validate arguments; throw UsageError on invalid input */
  check(argv: string[]): void;

  /** Run command and return exit code */
  run(argv: string[]): Promise<number>;
}
