/** Validate access grants and return sorted, unique principals, next expiry, and dropped grants */

import {
  PUBLIC_GROUP_NAME,
  PUBLIC_PRINCIPAL,
  Principal,
  emailPrincipal,
  groupPrincipal,
  subjectPrincipal,
} from '../common/principals';

import { parseUntil } from '../common/until';
import { ConfigService } from '../config/config.service';
import { PrincipalSet, UserGrant, providerType } from '../config/types';
import { Finding, FindingList } from './findings';
import { CodedError } from '../common/errors';

/** Provider identity directory */
export interface DirectoryLookup {
  /** Whether the provider has a directory */
  covers(provider: string): boolean;

  /** Resolve email to subject: null if absent, undefined if unsupported */
  resolveEmail(provider: string, email: string): Promise<string | null | undefined>;

  /** Check whether a subject exists */
  subjectExists(provider: string, subject: string): Promise<boolean>;

  /** Group member count, or null if unknown */
  groupSize(provider: string, groupId: string): Promise<number | null>;
}

/** Why a directory could not be reached */
export type DirectoryFailure =
  | 'unreachable'
  | 'request-failed'
  | 'credentials-refused'
  | 'token-unreachable'
  | 'token-refused'
  | 'token-missing'
  | 'not-installed'
  | 'installation-token-failed'
  | 'private-key-unusable'
  | 'app-refused'
  | 'cooldown';

/** Directory connection failure */
export class DirectoryUnavailableError extends CodedError<'directory.unavailable'> {
  constructor(
    readonly provider: string,
    readonly kind: DirectoryFailure, // Which failure, for callers and tests
    readonly reason: string, // What failed, in words
    readonly detail = '', // Operator-facing details
  ) {
    super('directory.unavailable', `directory for "${provider}" is unavailable: ${reason}`);
  }
}

/** Resolved access grants */
export interface ResolvedGrants {
  principals: Principal[]; // Sorted and deduplicated

  nextExpiry: Date | null; // Earliest resolved grant expiry, or null
  dropped: { principal: string; reason: string }[];
}

/** Grant resolution settings */
export interface GrantContext {
  config: ConfigService;
  directory?: DirectoryLookup;

  source: string; // Source file for diagnostics
  lineOf?: (keyPath: string) => number | null; // Config key to source line
  now: Date; // Reference time for expiry checks

  /** Require expiry dates for individual grants */
  requireUntil: boolean;

  expiryWarningMs: number; // Expiry warning window

  publicGrant: PublicGrant;
}

/** Public access: allowed, disabled for this repo, or forbidden for maintainers */
export type PublicGrant = 'enabled' | 'disabled' | 'refused';

/** Resolve groups and users, recording validation findings */
export async function resolveAccessBlock(
  set: PrincipalSet,
  ctx: GrantContext,
  findings: FindingList,
): Promise<ResolvedGrants> {
  const principals: Principal[] = [];
  const dropped: { principal: string; reason: string }[] = [];
  let nextExpiry: Date | null = null;

  for (const [index, name] of (set.groups ?? []).entries()) {
    const line =
      ctx.lineOf?.(`access.groups.${index}`) ?? ctx.lineOf?.('access.groups') ?? undefined;

    if (name === PUBLIC_GROUP_NAME) {
      // Public access uses policy, not group membership
      if (ctx.publicGrant !== 'enabled') {
        findings.reject({
          code: ctx.publicGrant === 'refused' ? 'public-not-a-maintainer' : 'public-not-enabled',
          source: ctx.source,
          line,
          message:
            ctx.publicGrant === 'refused'
              ? '`public` names readers with no credential and can never be a maintainer — ' +
                "operational access to this repository is not the internet's"
              : '`public` is not enabled for this repository. An administrator lists it ' +
                'under `public.repos` in the instance configuration first — publishing to ' +
                "the internet is not a repository's own decision to make.",
        });
        continue;
      }
      principals.push(PUBLIC_PRINCIPAL);
      continue;
    }

    if (!ctx.config.hasGroup(name)) {
      findings.reject({
        code: 'unknown-group',
        source: ctx.source,
        line,
        message: `unknown group "${name}"`,
        suggestion: ctx.config.suggestGroup(name) ?? undefined,
      });
      continue;
    }
    principals.push(groupPrincipal(name));
  }

  for (const [index, grant] of (set.users ?? []).entries()) {
    const line = ctx.lineOf?.(`access.users.${index}`) ?? ctx.lineOf?.('access.users') ?? undefined;
    const resolved = await resolveUserGrant(grant, ctx, findings, line, index, dropped);
    if (resolved === null) continue;
    principals.push(resolved.principal);
    if (resolved.until && (nextExpiry === null || resolved.until < nextExpiry)) {
      nextExpiry = resolved.until;
    }
  }

  return { principals: [...new Set(principals)].sort(), nextExpiry, dropped };
}

/** Validate and resolve a user grant, or record a finding and return null */
async function resolveUserGrant(
  grant: UserGrant,
  ctx: GrantContext,
  findings: FindingList,
  line: number | undefined,
  index: number,
  dropped: { principal: string; reason: string }[],
): Promise<{ principal: Principal; until: Date | null } | null> {
  const where = `access.users[${index}]`;

  const providerId = grant.provider ?? ctx.config.defaultProviderId;
  if (providerId === undefined) {
    findings.reject({
      code: 'ambiguous-provider',
      source: ctx.source,
      line,
      message:
        `${where}: \`provider\` is omitted, more than one provider is configured, and there ` +
        'is no auth.default_provider. Never guessed — say which provider you meant.',
    });
    return null;
  }
  const provider = ctx.config.provider(providerId);
  if (!provider) {
    findings.reject({
      code: 'unknown-provider',
      source: ctx.source,
      line,
      message: `${where}: unknown provider "${providerId}"`,
    });
    return null;
  }

  // Opaque subjects need a readable label
  if (grant.subject && !grant.note) {
    findings.reject({
      code: 'grant-missing-note',
      source: ctx.source,
      line,
      message: `${where}: \`note\` is required alongside \`subject\``,
    });
    return null;
  }

  if (ctx.requireUntil && !grant.until) {
    findings.reject({
      code: 'grant-missing-until',
      source: ctx.source,
      line,
      message: `${where}: \`until\` is required for individual grants`,
    });
    return null;
  }

  let until: Date | null = null;
  if (grant.until) {
    until = parseUntil(grant.until);
    if (until === null) {
      findings.reject({
        code: 'schema-invalid',
        source: ctx.source,
        line,
        message: `${where}: \`until\` is not a date: ${JSON.stringify(grant.until)}`,
      });
      return null;
    }
    if (until.getTime() <= ctx.now.getTime()) {
      // Drop expired grants with an info finding
      findings.info({
        code: 'grant-expired',
        source: ctx.source,
        line,
        message: `${where}: grant expired on ${grant.until} and was dropped`,
      });
      dropped.push({
        principal: describeGrant(grant, providerId),
        reason: `expired ${grant.until}`,
      });
      return null;
    }
    if (until.getTime() - ctx.now.getTime() <= ctx.expiryWarningMs) {
      findings.warn({
        code: 'grant-expiring',
        source: ctx.source,
        line,
        message: `${where}: grant expires on ${grant.until}`,
      });
    }
  }

  const kind = providerType(provider);

  if (grant.subject) {
    // Magic-link subjects are case-insensitive emails
    const subject = kind === 'magic-link' ? grant.subject.toLowerCase() : grant.subject;
    if (ctx.directory?.covers(providerId)) {
      // Keep the grant if the directory is unavailable
      const stillThere = await askDirectory(
        () => ctx.directory!.subjectExists(providerId, subject),
        true,
        { ctx, findings, line, where },
      );
      if (!stillThere) {
        findings.info({
          code: 'grant-unresolved',
          source: ctx.source,
          line,
          message: `${where}: no longer resolves in the directory and was dropped`,
        });
        dropped.push({
          principal: subjectPrincipal(providerId, subject),
          reason: 'no longer in directory',
        });
        return null;
      }
    }
    return { principal: subjectPrincipal(providerId, subject), until };
  }

  if (grant.email) {
    const email = grant.email.toLowerCase();
    if (kind === 'magic-link') {
      // Use email as subject without a directory lookup
      return { principal: subjectPrincipal(providerId, email), until };
    }
    if (ctx.directory?.covers(providerId)) {
      // Keep the email principal if lookup is unsupported or unavailable
      const subject = await askDirectory(
        () => ctx.directory!.resolveEmail(providerId, email),
        undefined,
        { ctx, findings, line, where },
      );
      if (subject === null) {
        findings.info({
          code: 'grant-unresolved',
          source: ctx.source,
          line,
          message: `${where}: address no longer resolves in the directory and was dropped`,
        });
        dropped.push({
          principal: emailPrincipal(providerId, email),
          reason: 'no longer in directory',
        });
        return null;
      }
      if (subject !== undefined) return { principal: subjectPrincipal(providerId, subject), until };
    }
    return { principal: emailPrincipal(providerId, email), until };
  }

  findings.reject({
    code: 'schema-invalid',
    source: ctx.source,
    line,
    message: `${where}: needs either \`subject\` (with \`note\`) or \`email\``,
  });
  return null;
}

/** On directory unavailability, record an info finding and return the fallback */
async function askDirectory<T>(
  ask: () => Promise<T>,
  fallback: T,
  at: { ctx: GrantContext; findings: FindingList; line: number | undefined; where: string },
): Promise<T> {
  try {
    return await ask();
  } catch (err) {
    // Propagate unexpected errors
    if (!(err instanceof DirectoryUnavailableError)) throw err;
    at.findings.info({
      code: 'directory-unavailable',
      source: at.ctx.source,
      line: at.line,
      message: `${at.where}: the directory could not be reached, so this grant was resolved as it would be without one`,
      adminMessage:
        `${at.where}: the directory for provider "${err.provider}" could not be reached ` +
        `(${err.reason}), so this grant was resolved as it would be without one`,
    });
    return fallback;
  }
}

/** Format a grant for the dropped list */
function describeGrant(grant: UserGrant, providerId: string): string {
  if (grant.subject) return subjectPrincipal(providerId, grant.subject);
  if (grant.email) return emailPrincipal(providerId, grant.email);
  return `user:${providerId}:<unspecified>`;
}

/** Count expired and unresolved grant findings */
export function findingsToDroppedGrants(findings: Finding[]): number {
  return findings.filter((f) => f.code === 'grant-expired' || f.code === 'grant-unresolved').length;
}
