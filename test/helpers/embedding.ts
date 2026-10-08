import { EmbeddingClient, FetchLike, ResolvedEmbeddingConfig } from '../../src/embed/client';

export const STUB_DIMENSIONS = 3;

export function hashingVector(text: string, dimensions: number): number[] {
  const out = new Array<number>(dimensions).fill(0);
  for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < 2) continue;
    let hash = 0;
    for (const char of token) hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
    out[hash % dimensions] += 1;
  }
  const length = Math.hypot(...out);
  if (length === 0) out[0] = 1;
  return length === 0 ? out : out.map((n) => n / length);
}

export interface StubEndpoint {
  client: EmbeddingClient;
  seen: string[];
  breakWith(status: number | null): void;
}

export function stubEmbeddingClient(
  overrides: Partial<ResolvedEmbeddingConfig> = {},
  embedder: (text: string, dimensions: number) => number[] = (text) => vectorFor(text),
): StubEndpoint {
  const config: ResolvedEmbeddingConfig = {
    base_url: 'https://embeddings.example.test/v1',
    model: 'stub-embed',
    dimensions: STUB_DIMENSIONS,
    send_dimensions: true,
    batch_size: 2,
    max_concurrency: 2,
    ...overrides,
  };

  const seen: string[] = [];
  let broken: number | null = null;

  const fetch: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as { input: string[] };
    if (broken !== null) {
      return {
        ok: false,
        status: broken,
        headers: { get: () => null },
        text: async () => 'stub failure',
      };
    }
    seen.push(...body.input);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () =>
        JSON.stringify({
          data: body.input.map((text, index) => ({
            index,
            embedding: embedder(text, config.dimensions),
          })),
        }),
    };
  };

  return {
    client: new EmbeddingClient(config, { fetch, sleep: async () => undefined }),
    seen,
    breakWith(status: number | null) {
      broken = status;
    },
  };
}

export function vectorFor(text: string): number[] {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
  return [hash / 100_000, text.length / 1000, 1];
}
