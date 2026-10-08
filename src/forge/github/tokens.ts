import { createPrivateKey } from 'node:crypto';

import { SignJWT } from 'jose';

import { Logger, rootLogger } from '../../common/logger';

interface CachedToken {
  token: string;
  expiresAt: number; // Epoch ms when GitHub says it expires
}

// Hand out a cached token only while at least this much life remains
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// App JWT lifetime: GitHub rejects app JWTs once they are ten minutes old
const APP_JWT_TTL_SECONDS = 540;

/** Mints app JWTs, caches installation tokens, and builds authenticated clone URLs */
export class GithubTokenMinter {
  private readonly cache = new Map<string, CachedToken>();
  private readonly log: Logger = rootLogger.child('forge.github');

  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly apiBase = 'https://api.github.com',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Sign an app JWT with the private key for app-level and installation-token calls */
  async appJwt(): Promise<string> {
    const key = createPrivateKey(normalizePem(this.privateKeyPem));
    const now = Math.floor(Date.now() / 1000);
    return (
      new SignJWT({})
        .setProtectedHeader({ alg: 'RS256' })

        // Backdated 60s so clock skew at GitHub cannot mark a fresh JWT invalid
        .setIssuedAt(now - 60)
        .setExpirationTime(now + APP_JWT_TTL_SECONDS)
        .setIssuer(this.appId)
        .sign(key)
    );
  }

  /** Installation-scoped token, cached until less than five minutes remain */
  async installationToken(installationId: string): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached.token;

    const jwt = await this.appJwt();
    const response = await this.fetchImpl(
      `${this.apiBase}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `could not mint an installation token for ${installationId}: ${response.status} ${response.statusText}`,
      );
    }
    const body = (await response.json()) as { token: string; expires_at: string };
    this.cache.set(installationId, {
      token: body.token,
      expiresAt: new Date(body.expires_at).getTime(),
    });
    this.log.debug('minted installation token', { installation_id: installationId });
    return body.token;
  }

  /** Clone URL with the installation token filled in as git credentials */
  async authenticatedUrl(installationId: string, cloneUrl: string): Promise<string> {
    const token = await this.installationToken(installationId);
    const url = new URL(cloneUrl);
    url.username = 'x-access-token';
    url.password = token;
    return url.toString();
  }

  /** Drop the cached token for an installation */
  forget(installationId: string): void {
    this.cache.delete(installationId);
  }
}

/** Repair pasted keys: expand \n escapes, trim, and append a trailing newline */
export function normalizePem(pem: string): string {
  const repaired = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  return repaired.trim() + '\n';
}

/** Validate a GitHub app key; returns an actionable complaint or null */
export function privateKeyProblem(pem: string): string | null {
  // Empty is accepted so a forge can run without GitHub auth
  if (pem.trim() === '') return null;
  try {
    createPrivateKey(normalizePem(pem));
    return null;
  } catch (err) {
    // No newline (real or escaped) means the line breaks were lost
    if (!/[\r\n]|\\n/.test(pem)) {
      return (
        'the line breaks in this key were lost, so it is one long line — paste it as ' +
        '`${VAR}` naming an environment variable that holds the file, or store the ' +
        '.pem and point at it'
      );
    }
    return `this key could not be read: ${(err as Error).message}`;
  }
}
