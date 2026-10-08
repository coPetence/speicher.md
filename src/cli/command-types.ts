export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface Command {
  /** One-line description for the usage banner */
  readonly summary: string;

  /** Placeholder string for the usage banner */
  readonly args: string;

  /** Whether the command needs the database schema to be up to date before it runs */
  readonly needsCurrentSchema: boolean;

  /** Validate arguments; throws UsageError on bad input */
  check(argv: string[]): void;

  /** Execute the command; returns the process exit code */
  run(argv: string[]): Promise<number>;
}
