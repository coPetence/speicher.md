import { createHmac } from 'node:crypto';

import { mapGithubEvent, verifyGithubSignature } from '../../src/forge/github/webhook';
import { TokenBucket } from '../../src/forge/rate-limit';
import { normalizePem } from '../../src/forge/github/tokens';

const SECRET = 'a-webhook-secret';

function signed(body: string, secret = SECRET) {
  return {
    headers: {
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`,
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'push',
    },
    body: Buffer.from(body),
  };
}

describe('signature verification', () => {
  it('accepts a correctly signed delivery', () => {
    const { headers, body } = signed('{"a":1}');
    expect(verifyGithubSignature(headers, body, SECRET)).toEqual({
      valid: true,
      deliveryId: 'delivery-1',
      event: 'push',
    });
  });

  it('rejects a body that was altered after signing', () => {
    const { headers } = signed('{"a":1}');
    expect(verifyGithubSignature(headers, Buffer.from('{"a":2}'), SECRET).valid).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const { headers, body } = signed('{"a":1}', 'the-wrong-secret');
    expect(verifyGithubSignature(headers, body, SECRET).valid).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(
      verifyGithubSignature({ 'x-github-event': 'push' }, Buffer.from('{}'), SECRET).valid,
    ).toBe(false);
  });

  it('rejects an sha1 signature, which GitHub still sends alongside', () => {
    expect(
      verifyGithubSignature({ 'x-hub-signature': 'sha1=deadbeef' }, Buffer.from('{}'), SECRET)
        .valid,
    ).toBe(false);
  });

  it('is sensitive to whitespace, because the raw body is what is signed', () => {
    const { headers } = signed('{"a":1}');
    expect(verifyGithubSignature(headers, Buffer.from('{"a": 1}'), SECRET).valid).toBe(false);
  });

  it('still reports the delivery id on a rejected delivery, for logging', () => {
    const { body } = signed('{"a":1}');
    const result = verifyGithubSignature(
      { 'x-github-delivery': 'd-9', 'x-github-event': 'push' },
      body,
      SECRET,
    );
    expect(result.deliveryId).toBe('d-9');
  });
});

describe('event mapping', () => {
  const tracked = () => 'main';

  it('syncs a push to the tracked branch', () => {
    expect(
      mapGithubEvent(
        'push',
        { ref: 'refs/heads/main', after: 'abc', repository: { id: 1, default_branch: 'main' } },
        tracked,
      ),
    ).toEqual([{ kind: 'sync', forgeRepoId: '1', sha: 'abc', reason: 'push' }]);
  });

  it('ignores a push to any other branch', () => {
    const actions = mapGithubEvent(
      'push',
      { ref: 'refs/heads/feature', after: 'abc', repository: { id: 1, default_branch: 'main' } },
      tracked,
    );
    expect(actions[0].kind).toBe('ignore');
  });

  it('ignores a tag push', () => {
    const actions = mapGithubEvent(
      'push',
      { ref: 'refs/tags/v1', repository: { id: 1, default_branch: 'main' } },
      tracked,
    );
    expect(actions[0].kind).toBe('ignore');
  });

  it('validates a pull request at its head', () => {
    expect(
      mapGithubEvent(
        'pull_request',
        {
          action: 'opened',
          repository: { id: 7 },
          pull_request: { number: 42, head: { sha: 'headsha' } },
        },
        tracked,
      ),
    ).toEqual([{ kind: 'validate-pr', forgeRepoId: '7', sha: 'headsha', prNumber: 42 }]);
  });

  it('ignores a pull request being closed', () => {
    const actions = mapGithubEvent(
      'pull_request',
      { action: 'closed', repository: { id: 7 }, pull_request: { number: 42, head: { sha: 'x' } } },
      tracked,
    );
    expect(actions[0].kind).toBe('ignore');
  });

  it('turns a rename into a rename action rather than a purge', () => {
    expect(
      mapGithubEvent(
        'repository',
        {
          action: 'renamed',
          repository: { id: 3, name: 'new-name' },
          changes: { repository: { name: { from: 'old-name' } } },
        },
        tracked,
      ),
    ).toEqual([{ kind: 'rename', forgeRepoId: '3', oldName: 'old-name', newName: 'new-name' }]);
  });

  it('purges on every form of removal', () => {
    for (const action of ['deleted', 'archived', 'transferred', 'privatized']) {
      const actions = mapGithubEvent('repository', { action, repository: { id: 3 } }, tracked);
      expect(actions[0].kind).toBe('purge');
    }
  });

  it('discovers on installation.created and purges on deleted', () => {
    expect(
      mapGithubEvent('installation', { action: 'created', installation: { id: 99 } }, tracked),
    ).toEqual([{ kind: 'discover', installationId: '99' }]);
    expect(
      mapGithubEvent('installation', { action: 'deleted', installation: { id: 99 } }, tracked),
    ).toEqual([{ kind: 'purge-installation', installationId: '99' }]);
  });

  it('handles added and removed repositories in one delivery', () => {
    const actions = mapGithubEvent(
      'installation_repositories',
      {
        installation: { id: 99 },
        repositories_added: [{ id: 1 }],
        repositories_removed: [{ id: 2 }],
      },
      tracked,
    );
    expect(actions.map((a) => a.kind)).toEqual(['discover', 'purge']);
  });

  it('invalidates the team cache on membership changes', () => {
    for (const event of ['team', 'membership', 'organization']) {
      const actions = mapGithubEvent(event, { organization: { login: 'acme' } }, tracked);
      expect(actions).toEqual([{ kind: 'invalidate-teams', namespace: 'acme' }]);
    }
  });

  it('ignores an event it does not handle', () => {
    expect(mapGithubEvent('star', {}, tracked)[0].kind).toBe('ignore');
  });
});

describe('token bucket', () => {
  it('permits up to capacity immediately, then makes the caller wait', () => {
    const now = 0;
    const bucket = new TokenBucket(2, 1, () => now);
    expect(bucket.delay()).toBe(0);
    bucket.take();
    expect(bucket.delay()).toBe(0);
    bucket.take();
    expect(bucket.delay()).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1, () => now);
    bucket.take();
    bucket.take();
    now = 2_000;
    expect(bucket.delay()).toBe(0);
  });

  it('honours a reset time the forge dictated', () => {
    let now = 1_000;
    const bucket = new TokenBucket(10, 10, () => now);
    bucket.blockUntil(5_000);
    expect(bucket.delay()).toBe(4_000);
    now = 5_001;
    expect(bucket.delay()).toBe(0);
  });
});

describe('private key handling', () => {
  it('repairs a PEM whose newlines arrived escaped', () => {
    const escaped = '-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----';
    expect(normalizePem(escaped)).toBe(
      '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n',
    );
  });

  it('leaves a well-formed PEM alone apart from the trailing newline', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';
    expect(normalizePem(pem)).toBe(`${pem}\n`);
  });
});
