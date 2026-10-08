/**
 * Client for an OpenAI-compatible /v1/embeddings endpoint
 *
 * Emits one POST per batch, with up to max_concurrency batches in flight
 * Retryable failures (429, 5xx, transport) retry up to MAX_ATTEMPTS with jittered
 * exponential backoff, honouring Retry-After when the endpoint sends one
 * verifyDimensions probes at startup so a model whose width differs from
 * embedding.dimensions fails the boot instead of part-way through an embed run
 */
import { Logger, rootLogger } from '../common/logger';

/** Attempts per batch request: one original plus up to three retries */
const MAX_ATTEMPTS = 4;

/** Base of the exponential backoff schedule */
const BASE_BACKOFF_MS = 500;

/** Cap on one backoff sleep */
const MAX_BACKOFF_MS = 30_000;

/** Attempts a width probe makes: fewer than a batch's, since someone is waiting on the answer */
const PROBE_ATTEMPTS = 3;

/** Wait before the first retry of a width probe; each later retry waits this much longer */
const PROBE_BACKOFF_MS = 1_000;

/** A Retry-After longer than this fails the probe rather than being waited out on a form */
const PROBE_MAX_WAIT_MS = 5_000;

/** Endpoint error bodies are truncated to this many characters in the message */
const ERROR_BODY_CHARS = 400;

/** Text embedded at startup to read back the model's returned width */
const PROBE_TEXT = 'dimension probe';

/** Embedding block after ConfigService has applied the schema defaults */
export interface ResolvedEmbeddingConfig {
  base_url: string;
  api_key?: string;
  model: string;
  dimensions: number;
  send_dimensions: boolean;
  batch_size: number;
  max_concurrency: number;
}

/** fetch-shaped call the client makes; stubbable so tests never touch the network */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Injectable dependencies: plain fetch and timers, replaced in tests */
export interface EmbeddingClientDeps {
  fetch?: FetchLike;

  sleep?: (ms: number) => Promise<void>;
}

/** An embedding request failure: the endpoint status and whether retrying can help */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** Model returned a different vector width than embedding.dimensions */
export class EmbeddingDimensionError extends Error {
  constructor(
    readonly configured: number,
    readonly returned: number,
    readonly model: string,
  ) {
    super(
      `embedding model "${model}" returned ${returned}-dimensional vectors, ` +
        `but embedding.dimensions is ${configured}. ` +
        'These must match: the pgvector column and its index are built to the ' +
        'configured width, so the mismatch would be discovered one Postgres error ' +
        'at a time, part-way through an embed run.',
    );
    this.name = 'EmbeddingDimensionError';
  }
}

/** Retrying, concurrency-limited HTTP client for one /v1/embeddings endpoint */
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
   * The width this endpoint returns for the model, from a probe request
   *
   * Compares nothing. It answers the configuration form asking what to type into
   * Dimensions, so it retries only what a moment can cure (429, 5xx, a transport
   * failure), and only a few times: the batch client's schedule is built for a job
   * nobody is watching, and an operator is. The request is the one a save would store:
   * the dimensions parameter goes out exactly when `send_dimensions` says so, so a
   * Matryoshka model answers at the width that will be used.
   */
  async probeWidth(): Promise<number> {
    const body = this.requestBody([PROBE_TEXT]);
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.attempt(body);
      if (outcome.ok) {
        const [vector] = outcome.vectors;
        if (!vector) {
          throw new EmbeddingError(
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

  /** Embed every text and return one vector per text, in input order */
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batches = chunkInto(texts, this.config.batch_size);
    const results = await pooled(batches, this.config.max_concurrency, (batch) =>
      this.embedBatch(batch),
    );
    return results.flat();
  }

  /** Embed a single probe text, verifying the returned width matches the config */
  async verifyDimensions(): Promise<number> {
    const [vector] = await this.embedBatch([PROBE_TEXT]);
    if (!vector) {
      throw new EmbeddingError('embedding endpoint returned no vector for the probe', null, false);
    }
    if (vector.length !== this.config.dimensions) {
      throw new EmbeddingDimensionError(this.config.dimensions, vector.length, this.config.model);
    }
    return vector.length;
  }

  /** The JSON body for one request: the model, the inputs, and the width when it is sent */
  private requestBody(input: readonly string[]): string {
    return JSON.stringify({
      model: this.config.model,
      input,
      // Some models error on an unknown `dimensions` parameter; sent only when configured
      ...(this.config.send_dimensions ? { dimensions: this.config.dimensions } : {}),
    });
  }

  /** POST one batch with up to MAX_ATTEMPTS attempts; returns vectors or the last error */
  private async embedBatch(input: readonly string[]): Promise<number[][]> {
    const body = this.requestBody(input);

    let lastError: EmbeddingError | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const outcome = await this.attempt(body);
      if (outcome.ok) return outcome.vectors;
      lastError = outcome.error;
      if (!outcome.error.retryable || attempt === MAX_ATTEMPTS) break;

      const wait = outcome.retryAfterMs ?? backoffFor(attempt);
      this.log.warn('embedding request failed; retrying', {
        attempt,
        of: MAX_ATTEMPTS,
        status: outcome.error.status,
        wait_ms: wait,
      });
      await this.sleep(wait);
    }
    throw lastError ?? new EmbeddingError('embedding request failed', null, false);
  }

  /** One plain POST attempt; never throws */
  private async attempt(
    body: string,
  ): Promise<
    | { ok: true; vectors: number[][] }
    | { ok: false; error: EmbeddingError; retryAfterMs: number | null }
  > {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.api_key) {
      headers.authorization = `Bearer ${this.config.api_key}`;
      // `api-key` too: Azure reads only this header, other providers read the bearer
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
      // fetch rejected before any response: status unknown, and a later attempt may land
      return {
        ok: false,
        error: new EmbeddingError(
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
          `embedding endpoint returned ${response.status}${detail ? `: ${detail}` : ''}`,
          response.status,
          isRetryable(response.status),
        ),
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      };
    }

    try {
      return { ok: true, vectors: parseVectors(await response.text()) };
    } catch (err) {
      // A 200 that is not the shape asked for: retrying would return the same body
      return {
        ok: false,
        error: new EmbeddingError((err as Error).message, response.status, false),
        retryAfterMs: null,
      };
    }
  }
}

/** base_url with trailing slashes trimmed, joined with /embeddings */
export function embeddingsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/embeddings`;
}

/**
 * How long one width-probe attempt waits on the endpoint before it counts as a failure
 *
 * A local model server can take several seconds to load a model on the first request;
 * the attempt that times out is the one the retry lands on, once the model is loaded.
 * Three attempts bound the wait of a page to about half a minute.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/** The platform fetch with a deadline, for a request an operator is waiting on */
export function fetchWithin(ms: number): FetchLike {
  return (url, init) => globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Parse a response body into vectors, each entry placed at its reported index */
function parseVectors(raw: string): number[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('embedding endpoint returned a body that is not JSON');
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error('embedding response has no `data` array');
  }

  const out: number[][] = new Array(data.length);
  data.forEach((entry, position) => {
    const record = entry as { index?: unknown; embedding?: unknown };
    const at = typeof record.index === 'number' ? record.index : position;
    if (!Array.isArray(record.embedding)) {
      throw new Error(`embedding response entry ${at} has no \`embedding\` array`);
    }
    out[at] = record.embedding as number[];
  });
  if (out.some((vector) => vector === undefined)) {
    throw new Error('embedding response is missing an entry');
  }
  return out;
}

/** Best-effort read of an error response body, '' when it cannot be read */
async function safeText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return '';
  }
}

/** True for the statuses (429, 5xx) a retry can plausibly fix */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Parse Retry-After, given as whole seconds or an HTTP-date, into ms to wait */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/** Exponential schedule with full jitter, capped at MAX_BACKOFF_MS */
function backoffFor(attempt: number): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  // Full jitter: pick uniformly in [0, exponential]
  return Math.round(Math.random() * exponential);
}

/** Split items into consecutive non-overlapping slices of at most size */
function chunkInto<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

/** Run every item through task with at most limit in flight, results in input order */
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
