import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Field } from '../../src/dashboard/configurator/config-form/config-fields';
import { fillUploads } from '../../src/dashboard/configurator/config-form/upload';

// Keys created with `ssh-keygen` for this test only; they open nothing
const KEYS = join(__dirname, '../fixtures/ssh');
const PATH = 'forges.onprem.repos.0.deploy_key';

const field = {
  kind: 'secret',
  path: PATH,
  upload: {
    accept: '',
    content: 'ssh-private-key',
    label: 'Choose key file…',
    dropLabel: 'Drop the private key file here',
  },
} as unknown as Field;

async function upload(file: string): Promise<{ refusal: string | null; value: unknown }> {
  const body: Record<string, unknown> = {};
  const refusal = await fillUploads(
    [field],
    { parts: new Map([[`file:${PATH}`, readFileSync(join(KEYS, file))]]), refusal: null },
    body,
    // A deploy key is no brand image, so nothing is interned
    () => Promise.reject(new Error('a deploy key is not interned')),
  );
  return { refusal, value: body[PATH] };
}

describe('a deploy key chosen as a file', () => {
  it('is stored as the text of the key', async () => {
    const { refusal, value } = await upload('deploy-key');
    expect(refusal).toBeNull();
    expect(value).toBe(readFileSync(join(KEYS, 'deploy-key'), 'utf8'));
  });

  it('may be an older key in PEM', async () => {
    expect((await upload('deploy-key-pem')).refusal).toBeNull();
  });

  it('is refused when a passphrase protects it, and says how to remove it', async () => {
    const { refusal, value } = await upload('deploy-key-with-passphrase');
    expect(refusal).toContain('passphrase');
    expect(refusal).toContain('ssh-keygen -p');
    expect(value).toBeUndefined();
  });

  it('is refused when it is the public key', async () => {
    expect((await upload('deploy-key.pub')).refusal).toContain('public key');
  });
});
