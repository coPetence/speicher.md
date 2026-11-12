import { promises as fs } from 'node:fs';
import os from 'node:os';

import { GitInvocation, httpsUrl, sshCommand, withGitCredential } from '../../src/forge/credential';

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaAAAA\n-----END OPENSSH PRIVATE KEY-----';
const HOSTS = 'git.example.test ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI';

describe('an ssh remote', () => {
  async function invoke(): Promise<{ invocation: GitInvocation; dir: string }> {
    let captured: GitInvocation | null = null;
    await withGitCredential(
      'ssh://git@git.example.test/ops/handbook.git',
      { deployKey: KEY, knownHosts: HOSTS },
      async (invocation) => {
        captured = invocation;
        return null;
      },
    );
    const invocation = captured as unknown as GitInvocation;
    return { invocation, dir: keyPathOf(invocation).replace(/\/deploy_key'?$/, '') };
  }

  it('offers only the configured key', async () => {
    const { invocation } = await invoke();
    expect(invocation.env!.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes');
  });

  it('pins the host key and offers no first-use exception', async () => {
    const { invocation } = await invoke();
    const command = invocation.env!.GIT_SSH_COMMAND;
    expect(command).toContain('StrictHostKeyChecking=yes');
    expect(command).toContain('UserKnownHostsFile=');
    expect(command).not.toContain('accept-new');
    expect(command).not.toContain('StrictHostKeyChecking=no');
  });

  it('never blocks on a prompt', async () => {
    const { invocation } = await invoke();
    expect(invocation.env!.GIT_SSH_COMMAND).toContain('BatchMode=yes');
  });

  it('leaves the key unreadable to anyone but this process', async () => {
    let mode = 0;
    await withGitCredential(
      'ssh://git@git.example.test/ops/handbook.git',
      { deployKey: KEY, knownHosts: HOSTS },
      async (invocation) => {
        const stat = await fs.stat(unquote(keyPathOf(invocation)));
        mode = stat.mode & 0o777;
      },
    );
    expect(mode).toBe(0o600);
  });

  it('takes the key away again, even when the fetch throws', async () => {
    let keyPath = '';
    const failure = await withGitCredential(
      'ssh://git@git.example.test/ops/handbook.git',
      { deployKey: KEY, knownHosts: HOSTS },
      async (invocation) => {
        keyPath = unquote(keyPathOf(invocation));
        throw new Error('remote hung up');
      },
    ).catch((err: Error) => err);

    expect(failure).toBeInstanceOf(Error);
    await expect(fs.stat(keyPath)).rejects.toThrow();
  });

  it('carries no credential in the URL, so there is nothing to redact', async () => {
    const { invocation } = await invoke();
    expect(invocation.authenticatedUrl).toBe('ssh://git@git.example.test/ops/handbook.git');
  });
});

describe('an ssh remote under a UID without a passwd entry', () => {
  afterEach(() => jest.restoreAllMocks());

  it('needs no passwd wrapper when the UID has an entry', async () => {
    await withGitCredential(
      'ssh://git@git.example.test/ops/handbook.git',
      { deployKey: KEY, knownHosts: HOSTS },
      async (invocation) => {
        expect(invocation.env!.LD_PRELOAD).toBeUndefined();
      },
    );
  });

  it('gives ssh a passwd entry for the current UID', async () => {
    jest.spyOn(os, 'userInfo').mockImplementation(() => {
      throw new Error('uv_os_get_passwd returned ENOENT');
    });
    let passwd = '';
    let group = '';
    let env: Record<string, string> = {};
    await withGitCredential(
      'ssh://git@git.example.test/ops/handbook.git',
      { deployKey: KEY, knownHosts: HOSTS },
      async (invocation) => {
        env = invocation.env!;
        passwd = await fs.readFile(env.NSS_WRAPPER_PASSWD, 'utf8');
        group = await fs.readFile(env.NSS_WRAPPER_GROUP, 'utf8');
      },
    );
    expect(env.LD_PRELOAD).toBe('libnss_wrapper.so');
    expect(env.GIT_SSH_COMMAND).toContain('BatchMode=yes');
    expect(passwd).toMatch(new RegExp(`^speicher:x:${process.getuid!()}:${process.getgid!()}:`));
    expect(group).toBe(`speicher:x:${process.getgid!()}:\n`);
    await expect(fs.stat(env.NSS_WRAPPER_PASSWD)).rejects.toThrow();
  });
});

describe('an https remote', () => {
  it('puts the token in the URL, where the sync path already scrubs it', async () => {
    let url = '';
    await withGitCredential(
      'https://git.example.test/ops/handbook.git',
      { token: 'glpat-secret', username: 'oauth2' },
      async (invocation) => {
        url = invocation.authenticatedUrl;
      },
    );
    expect(url).toBe('https://oauth2:glpat-secret@git.example.test/ops/handbook.git');
  });

  it('escapes a token that would otherwise end the userinfo early', () => {
    const url = httpsUrl('https://git.example.test/ops/handbook.git', {
      token: 'a@b/c',
      username: 'x-access-token',
    });
    expect(new URL(url).host).toBe('git.example.test');
    expect(url).toContain('a%40b%2Fc');
  });

  it('needs no ssh environment', async () => {
    await withGitCredential(
      'https://git.example.test/ops/handbook.git',
      { token: 't' },
      async (invocation) => {
        expect(invocation.env).toBeUndefined();
      },
    );
  });
});

describe('any other transport', () => {
  it('is refused rather than fetched', async () => {
    await expect(
      withGitCredential('git://git.example.test/ops/handbook.git', {}, async () => null),
    ).rejects.toFailWith('git.transport-unsupported');
  });
});

describe('the ssh command itself', () => {
  it('quotes paths, because a tmpdir may contain a space', () => {
    const command = sshCommand('/tmp/a b/deploy_key', '/tmp/a b/known_hosts');
    expect(command).toContain(`'/tmp/a b/deploy_key'`);
    expect(command).toContain(`UserKnownHostsFile='/tmp/a b/known_hosts'`);
  });
});

function keyPathOf(invocation: GitInvocation): string {
  const match = /-i (\S+)/.exec(invocation.env!.GIT_SSH_COMMAND);
  return match![1];
}

function unquote(value: string): string {
  return value.replace(/^'|'$/g, '');
}
