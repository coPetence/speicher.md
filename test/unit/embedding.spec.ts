import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigService } from '../../src/config/config.service';
import { loadInstanceConfigFromFile } from '../../src/config/parser';
import {
  EmbeddingClient,
  EmbeddingDimensionError,
  EmbeddingError,
  FetchLike,
  ResolvedEmbeddingConfig,
  embeddingsUrl,
} from '../../src/embed/client';
import { createEmbeddingClient } from '../../src/embed/embed.module';
import { checkEmbeddingDimensions } from '../../src/embed/embedding-guard';

const CONFIG: ResolvedEmbeddingConfig = {
  base_url: 'https://embeddings.example.test/v1',
  api_key: 'sk-test',
  model: 'text-embedding-3-small',
  dimensions: 4,
  send_dimensions: true,
  batch_size: 3,
  max_concurrency: 2,
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { model: string; input: string[]; dimensions?: number };
}

function stubEndpoint(
  respond: (
    call: Call,
    n: number,
  ) => Promise<{ status: number; body: string; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  let inFlight = 0;
  let peak = 0;

  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, headers: init.headers, body: JSON.parse(init.body) };
    calls.push(call);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      const result = await respond(call, calls.length);
      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        headers: { get: (name: string) => result.headers?.[name.toLowerCase()] ?? null },
        text: async () => result.body,
      };
    } finally {
      inFlight -= 1;
    }
  };

  return { fetch, calls, peak: () => peak };
}

function vectorsFor(input: string[], width = CONFIG.dimensions): string {
  return JSON.stringify({
    model: CONFIG.model,
    data: input.map((text, index) => ({
      index,
      embedding: Array.from({ length: width }, (_, i) => text.length + i),
    })),
  });
}

const noSleep = async () => undefined;

describe('EmbeddingClient', () => {
  it('posts to {base_url}/embeddings, whatever the trailing slash', () => {
    expect(embeddingsUrl('https://x.test/v1')).toBe('https://x.test/v1/embeddings');
    expect(embeddingsUrl('https://x.test/v1/')).toBe('https://x.test/v1/embeddings');
    expect(embeddingsUrl('https://x.test/v1///')).toBe('https://x.test/v1/embeddings');
  });

  it('batches by batch_size and returns every vector in request order', async () => {
    const endpoint = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input),
    }));
    const client = new EmbeddingClient(CONFIG, { fetch: endpoint.fetch, sleep: noSleep });

    const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg'];
    const vectors = await client.embed(texts);

    expect(endpoint.calls).toHaveLength(3);
    expect(endpoint.calls.map((c) => c.body.input)).toEqual([
      ['a', 'bb', 'ccc'],
      ['dddd', 'eeeee', 'ffffff'],
      ['ggggggg'],
    ]);
    expect(vectors).toHaveLength(texts.length);
    expect(vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length));
  });

  it('caps in-flight requests at max_concurrency', async () => {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;

    const endpoint = stubEndpoint(async (call) => {
      started += 1;
      if (started <= CONFIG.max_concurrency) await held;
      return { status: 200, body: vectorsFor(call.body.input) };
    });
    const client = new EmbeddingClient(CONFIG, { fetch: endpoint.fetch, sleep: noSleep });

    const pending = client.embed(Array.from({ length: 12 }, (_, i) => 'x'.repeat(i + 1)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(endpoint.calls).toHaveLength(CONFIG.max_concurrency);

    (release as unknown as () => void)();
    await pending;
    expect(endpoint.calls).toHaveLength(4);
    expect(endpoint.peak()).toBe(CONFIG.max_concurrency);
  });

  it('retries a 429 and honours Retry-After', async () => {
    const waits: number[] = [];
    const endpoint = stubEndpoint(async (call, n) =>
      n === 1
        ? { status: 429, body: 'slow down', headers: { 'retry-after': '2' } }
        : { status: 200, body: vectorsFor(call.body.input) },
    );
    const client = new EmbeddingClient(CONFIG, {
      fetch: endpoint.fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    const vectors = await client.embed(['a']);
    expect(vectors).toHaveLength(1);
    expect(endpoint.calls).toHaveLength(2);
    expect(waits).toEqual([2000]);
  });

  it("retries a 5xx and gives up with the endpoint's own message", async () => {
    const endpoint = stubEndpoint(async () => ({ status: 503, body: 'upstream unavailable' }));
    const client = new EmbeddingClient(CONFIG, { fetch: endpoint.fetch, sleep: noSleep });

    await expect(client.embed(['a'])).rejects.toThrow(/503.*upstream unavailable/);
    expect(endpoint.calls).toHaveLength(4);
  });

  it('does not retry a 400, because the request is what is wrong', async () => {
    const endpoint = stubEndpoint(async () => ({
      status: 400,
      body: '{"error":{"message":"unknown parameter: dimensions"}}',
    }));
    const client = new EmbeddingClient(CONFIG, { fetch: endpoint.fetch, sleep: noSleep });

    await expect(client.embed(['a'])).rejects.toThrow(EmbeddingError);
    expect(endpoint.calls).toHaveLength(1);
  });

  it('omits dimensions entirely when send_dimensions is false', async () => {
    const endpoint = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input),
    }));
    const client = new EmbeddingClient(
      { ...CONFIG, send_dimensions: false },
      { fetch: endpoint.fetch, sleep: noSleep },
    );
    await client.embed(['a']);

    expect('dimensions' in endpoint.calls[0].body).toBe(false);
  });

  it('sends the key both ways, because the schema promises Azure', async () => {
    const endpoint = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input),
    }));
    await new EmbeddingClient(CONFIG, { fetch: endpoint.fetch, sleep: noSleep }).embed(['a']);

    expect(endpoint.calls[0].headers.authorization).toBe('Bearer sk-test');
    expect(endpoint.calls[0].headers['api-key']).toBe('sk-test');
  });

  it('sends no credential header at all when there is no key', async () => {
    const endpoint = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input),
    }));
    const withoutKey: ResolvedEmbeddingConfig = { ...CONFIG };
    delete withoutKey.api_key;
    await new EmbeddingClient(withoutKey, { fetch: endpoint.fetch, sleep: noSleep }).embed(['a']);

    expect(endpoint.calls[0].headers.authorization).toBeUndefined();
    expect(endpoint.calls[0].headers['api-key']).toBeUndefined();
  });

  it('costs no request at all for an empty list', async () => {
    const endpoint = stubEndpoint(async () => ({ status: 200, body: '{}' }));
    expect(await new EmbeddingClient(CONFIG, { fetch: endpoint.fetch }).embed([])).toEqual([]);
    expect(endpoint.calls).toHaveLength(0);
  });

  it('puts a batch back in order by the index the endpoint reports', async () => {
    const endpoint = stubEndpoint(async (call) => ({
      status: 200,
      body: JSON.stringify({
        data: call.body.input
          .map((text, index) => ({ index, embedding: [text.length, 0, 0, 0] }))
          .reverse(),
      }),
    }));
    const client = new EmbeddingClient(CONFIG, { fetch: endpoint.fetch, sleep: noSleep });

    const vectors = await client.embed(['a', 'bb', 'ccc']);
    expect(vectors.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it('refuses a 200 whose body is not the shape it asked for, without retrying', async () => {
    const endpoint = stubEndpoint(async () => ({ status: 200, body: '<html>login</html>' }));
    const client = new EmbeddingClient(CONFIG, { fetch: endpoint.fetch, sleep: noSleep });

    await expect(client.embed(['a'])).rejects.toThrow(/not JSON/);
    expect(endpoint.calls).toHaveLength(1);
  });

  it('retries a transport failure and never quotes the request', async () => {
    let n = 0;
    const client = new EmbeddingClient(CONFIG, {
      sleep: noSleep,
      fetch: async () => {
        n += 1;
        throw new Error('getaddrinfo ENOTFOUND embeddings.example.test');
      },
    });

    await expect(client.embed(['a'])).rejects.toThrow(/unreachable/);
    expect(n).toBe(4);
    await expect(client.embed(['a'])).rejects.not.toThrow(/sk-test/);
  });
});

describe('the startup probe', () => {
  const probeConfig = { ...CONFIG, dimensions: 1536 };

  it('costs one request when the width is right', async () => {
    const endpoint = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input, 1536),
    }));
    const client = new EmbeddingClient(probeConfig, { fetch: endpoint.fetch, sleep: noSleep });

    expect(await checkEmbeddingDimensions(undefined, client)).toEqual({
      status: 'ok',
      dimensions: 1536,
    });
    expect(endpoint.calls).toHaveLength(1);
  });

  it('stops the boot on a mismatch, naming both numbers', async () => {
    const endpoint = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input, 768),
    }));
    const client = new EmbeddingClient(probeConfig, { fetch: endpoint.fetch, sleep: noSleep });

    await expect(checkEmbeddingDimensions(undefined, client)).rejects.toThrow(
      EmbeddingDimensionError,
    );
    await expect(checkEmbeddingDimensions(undefined, client)).rejects.toThrow(
      /768.*1536|1536.*768/s,
    );
  });

  it('starts anyway when the endpoint is unreachable', async () => {
    const client = new EmbeddingClient(probeConfig, {
      sleep: noSleep,
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const result = await checkEmbeddingDimensions(undefined, client);
    expect(result.status).toBe('unreachable');
  });

  it('has nothing to probe on an instance with no embedding block', async () => {
    expect(await checkEmbeddingDimensions(fixtureConfig())).toEqual({ status: 'unconfigured' });
  });
});

describe('the width probe behind the configuration form', () => {
  it('reports the width the endpoint returns, whatever dimensions is configured', async () => {
    const endpoint = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input, 1536),
    }));
    const client = new EmbeddingClient(
      { ...CONFIG, dimensions: 512, send_dimensions: false },
      { fetch: endpoint.fetch, sleep: noSleep },
    );

    expect(await client.probeWidth()).toBe(1536);
    expect(endpoint.calls).toHaveLength(1);
  });

  it('retries a failure a moment can cure, and answers from the attempt that works', async () => {
    const endpoint = stubEndpoint(async (call, n) =>
      n === 1
        ? { status: 429, body: 'slow down' }
        : { status: 200, body: vectorsFor(call.body.input, 1536) },
    );
    const sleeps: number[] = [];
    const client = new EmbeddingClient(CONFIG, {
      fetch: endpoint.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(await client.probeWidth()).toBe(1536);
    expect(endpoint.calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("gives up after three attempts, with the endpoint's own status", async () => {
    const endpoint = stubEndpoint(async () => ({ status: 503, body: 'upstream unavailable' }));
    const client = new EmbeddingClient(CONFIG, { fetch: endpoint.fetch, sleep: noSleep });

    await expect(client.probeWidth()).rejects.toMatchObject({ status: 503 });
    expect(endpoint.calls).toHaveLength(3);
  });

  it('does not retry a 400, and does not wait out a Retry-After a form would not sit through', async () => {
    const refused = stubEndpoint(async () => ({ status: 400, body: 'bad request' }));
    await expect(
      new EmbeddingClient(CONFIG, { fetch: refused.fetch, sleep: noSleep }).probeWidth(),
    ).rejects.toMatchObject({ status: 400 });
    expect(refused.calls).toHaveLength(1);

    const slow = stubEndpoint(async () => ({
      status: 429,
      body: 'slow down',
      headers: { 'retry-after': '60' },
    }));
    const sleeps: number[] = [];
    const client = new EmbeddingClient(CONFIG, {
      fetch: slow.fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(client.probeWidth()).rejects.toMatchObject({ status: 429 });
    expect(slow.calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('sends the dimensions parameter exactly when a save would, so the answer is the stored width', async () => {
    const sent = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input, 512),
    }));
    await new EmbeddingClient(
      { ...CONFIG, dimensions: 512, send_dimensions: true },
      { fetch: sent.fetch, sleep: noSleep },
    ).probeWidth();
    expect(sent.calls[0].body.dimensions).toBe(512);

    const native = stubEndpoint(async (call) => ({
      status: 200,
      body: vectorsFor(call.body.input, 1536),
    }));
    await new EmbeddingClient(
      { ...CONFIG, dimensions: 512, send_dimensions: false },
      { fetch: native.fetch, sleep: noSleep },
    ).probeWidth();
    expect('dimensions' in native.calls[0].body).toBe(false);
  });
});

describe('an instance with no embedding block', () => {
  it('constructs no client, rather than throwing at boot', () => {
    const config = fixtureConfig();
    expect(config.embedding).toBeNull();
    expect(createEmbeddingClient(config)).toBeNull();
  });
});

describe('the defaults', () => {
  it("are the schema's own", () => {
    const schema = JSON.parse(
      readFileSync(join(__dirname, '../../src/config/schema/instance.schema.json'), 'utf8'),
    );
    const properties = schema.properties.embedding.properties;

    const filled = withEmbedding(fixtureConfig(), {
      base_url: 'https://x.test/v1',
      model: 'm',
      dimensions: 8,
    });

    expect(filled.send_dimensions).toBe(properties.send_dimensions.default);
    expect(filled.batch_size).toBe(properties.batch_size.default);
    expect(filled.max_concurrency).toBe(properties.max_concurrency.default);
  });
});

function fixtureConfig(): ConfigService {
  return new ConfigService(loadInstanceConfigFromFile(process.env.SPEICHER_CONFIG as string));
}

function withEmbedding(
  config: ConfigService,
  embedding: Record<string, unknown>,
): ResolvedEmbeddingConfig {
  const loaded = config.loadedConfig;
  const patched = new ConfigService({
    ...loaded,
    raw: { ...loaded.raw, embedding },
  } as unknown as typeof loaded);
  return patched.embedding as ResolvedEmbeddingConfig;
}
