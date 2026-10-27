/** OpenAI-compatible embedding client with batching, concurrency limits, and retries */
import { Logger, rootLogger } from '../common/logger';
import { backoffMs, retryAfterHeaderToMs } from '../common/time';
import { CodedError } from '../common/errors';

/** Initial request plus three retries */
const MAX_ATTEMPTS = 4;

/** Initial batch retry delay */
const BASE_BACKOFF_MS = 500;

/** Maximum batch backoff delay */
const MAX_BACKOFF_MS = 30_000;

/** Maximum probe attempts */
const PROBE_ATTEMPTS = 3;

/** Probe retry delay increases by this amount per attempt */
const PROBE_BACKOFF_MS = 1_000;

/** Fail probes requiring a longer retry delay */
const PROBE_MAX_WAIT_MS = 5_000;

/** Maximum error body characters included in messages */
const ERROR_BODY_CHARS = 400;

/** Input used to probe vector dimensions */
const PROBE_TEXT = 'dimension probe';

/** Embedding config with schema defaults applied */
export interface ResolvedEmbeddingConfig {
  base_url: string;
  api_key?: string;
  model: string;
  dimensions: number;
  send_dimensions: boolean;
  batch_size: number;
  max_concurrency: number;
}

/** Minimal fetch interface for requests and test stubs */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Injectable fetch and sleep implementations */
export interface EmbeddingClientDeps {
  fetch?: FetchLike;

  sleep?: (ms: number) => Promise<void>;
}

/** Embedding failure codes */
export type EmbeddingCode =
  | 'embedding.unreachable'
  | 'embedding.http-status'
  | 'embedding.not-json'
  | 'embedding.bad-response'
  | 'embedding.failed';

/** Request error with HTTP status and retry eligibility */
export class EmbeddingError extends CodedError<EmbeddingCode> {
  constructor(
    code: EmbeddingCode,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(code, message);
  }
}

/** Returned vector dimensions differ from configuration */
export class EmbeddingDimensionError extends CodedError<'embedding.dimension-mismatch'> {
  constructor(
    readonly configured: number,
    readonly returned: number,
    readonly model: string,
  ) {
    super(
      'embedding.dimension-mismatch',
      `embedding model "${model}" returned ${returned}-dimensional vectors, ` +
        `but embedding.dimensions is ${configured}. ` +
        'These must match: the pgvector column and its index are built to the ' +
        'configured width, so the mismatch would be discovered one Postgres error ' +
        'at a time, part-way through an embed run.',
    );
  }
}

/** Embedding HTTP client with retries and bounded concurrency */
export class EmbeddingClient {
  private readonly log: Logger;
  private readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    readonly config: ResolvedEmbeddingConfig,
    deps: EmbeddingClientDeps = {},
  ) {
    this.log = rootLogger.child('embed');
    this.fetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  get model(): string {
    return this.config.model;
  }

  get dimensions(): number {
    return this.config.dimensions;
  }

  /**
   * Probe vector dimensions without validating them against config
   * Honors send_dimensions and uses short retries for interactive use
   */
  async probeWidth(): Promise<number> {
    const body = this.requestBody([PROBE_TEXT]);
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.attempt(body);
      if (outcome.ok) {
        const [vector] = outcome.vectors;
        if (!vector) {
          throw new EmbeddingError(
            'embedding.bad-response',
            'embedding endpoint returned no vector for the probe',
            null,
            false,
          );
        }
        return vector.length;
      }

      const wait = outcome.retryAfterMs ?? PROBE_BACKOFF_MS * attempt;
      if (!outcome.error.retryable || attempt >= PROBE_ATTEMPTS || wait > PROBE_MAX_WAIT_MS) {
        throw outcome.error;
      }
      await this.sleep(wait);
    }
  }

  /** Embed texts in batches, preserving input order */
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batches = chunkInto(texts, this.config.batch_size);
    const results = await pooled(batches, this.config.max_concurrency, (batch) =>
      this.embedBatch(batch),
    );
    return results.flat();
  }

  /** Probe and validate vector dimensions against config */
  async verifyDimensions(): Promise<number> {
    const [vector] = await this.embedBatch([PROBE_TEXT]);
    if (!vector) {
      throw new EmbeddingError(
        'embedding.bad-response',
        'embedding endpoint returned no vector for the probe',
        null,
        false,
      );
    }
    if (vector.length !== this.config.dimensions) {
      throw new EmbeddingDimensionError(this.config.dimensions, vector.length, this.config.model);
    }
    return vector.length;
  }

  /** Build the embedding request body */
  private requestBody(input: readonly string[]): string {
    return JSON.stringify({
      model: this.config.model,
      input,
      // Omit dimensions unless enabled; some models reject it
      ...(this.config.send_dimensions ? { dimensions: this.config.dimensions } : {}),
    });
  }

  /** Send a batch with retries; throw on failure */
  private async embedBatch(input: readonly string[]): Promise<number[][]> {
    const body = this.requestBody(input);

    let lastError: EmbeddingError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const outcome = await this.attempt(body);
      if (outcome.ok) return outcome.vectors;
      lastError = outcome.error;
      if (!outcome.error.retryable || attempt === MAX_ATTEMPTS) break;

      const wait = outcome.retryAfterMs ?? backoffMs(attempt, BASE_BACKOFF_MS, MAX_BACKOFF_MS);
      this.log.warn('embedding request failed; retrying', {
        attempt,
        of: MAX_ATTEMPTS,
        status: outcome.error.status,
        wait_ms: wait,
      });
      await this.sleep(wait);
    }
    throw (
      lastError ?? new EmbeddingError('embedding.failed', 'embedding request failed', null, false)
    );
  }

  /** Send one request and return vectors or error details */
  private async attempt(
    body: string,
  ): Promise<
    | { ok: true; vectors: number[][] }
    | { ok: false; error: EmbeddingError; retryAfterMs: number | null }
  > {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.api_key) {
      headers.authorization = `Bearer ${this.config.api_key}`;
      // Azure requires api-key instead of Bearer auth
      headers['api-key'] = this.config.api_key;
    }

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetch(embeddingsUrl(this.config.base_url), {
        method: 'POST',
        headers,
        body,
      });
    } catch (err) {
      // Transport failures are retryable and have no HTTP status
      return {
        ok: false,
        error: new EmbeddingError(
          'embedding.unreachable',
          `embedding endpoint unreachable: ${(err as Error).message}`,
          null,
          true,
        ),
        retryAfterMs: null,
      };
    }

    if (!response.ok) {
      const detail = (await safeText(response)).slice(0, ERROR_BODY_CHARS);
      return {
        ok: false,
        error: new EmbeddingError(
          'embedding.http-status',
          `embedding endpoint returned ${response.status}${detail ? `: ${detail}` : ''}`,
          response.status,
          isRetryable(response.status),
        ),
        retryAfterMs: retryAfterHeaderToMs(response.headers.get('retry-after')),
      };
    }

    try {
      return { ok: true, vectors: parseVectors(await response.text()) };
    } catch (err) {
      // Do not retry unreadable or invalid success responses
      return {
        ok: false,
        error: new EmbeddingError(
          err instanceof EmbeddingError ? err.code : 'embedding.bad-response',
          (err as Error).message,
          response.status,
          false,
        ),
        retryAfterMs: null,
      };
    }
  }
}

/** Append /embeddings after removing trailing slashes */
export function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/embeddings`;
}

/** Per-attempt probe timeout, allowing time for model loading */
export const PROBE_TIMEOUT_MS = 10_000;

/** Create a fetch wrapper with a request timeout */
export function fetchWithin(ms: number): FetchLike {
  return (url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Parse vectors into reported index order */
function parseVectors(raw: string): number[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new EmbeddingError(
      'embedding.not-json',
      'embedding endpoint returned a body that is not JSON',
      null,
      false,
    );
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new EmbeddingError(
      'embedding.bad-response',
      'embedding response has no `data` array',
      null,
      false,
    );
  }

  const out: number[][] = new Array(data.length);
  data.forEach((entry, position) => {
    const record = entry as { index?: unknown; embedding?: unknown };
    const at = typeof record.index === 'number' ? record.index : position;
    if (!Array.isArray(record.embedding)) {
      throw new EmbeddingError(
        'embedding.bad-response',
        `embedding response entry ${at} has no \`embedding\` array`,
        null,
        false,
      );
    }
    out[at] = record.embedding as number[];
  });
  if (out.some((vector) => vector === undefined)) {
    throw new EmbeddingError(
      'embedding.bad-response',
      'embedding response is missing an entry',
      null,
      false,
    );
  }
  return out;
}

/** Read and trim the response body; return empty text on failure */
async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

/** Retry 429 and statuses of 500 or higher */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Split items into chunks of at most size */
function chunkInto<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

/** Run tasks with bounded concurrency, preserving input order */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await task(items[index] as T);
    }
  });
  await Promise.all(workers);
  return out;
}
