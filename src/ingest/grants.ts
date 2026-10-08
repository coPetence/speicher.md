/**
 * Resolve access grants into resolved principals
 *
 * A PrincipalSet names groups and individual user grants (by subject or email)
 * Each grant is validated: schema, expiry, directory membership, public policy
 * A grant that fails validation is recorded in the findings and dropped
 *
 * The result is a deduplicated sorted list of resolved principals, the nearest
 * expiry among all grants, and a list of grants that were dropped
 */

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

/** External identity directory for a provider */
export interface DirectoryLookup {
  /** Whether a directory is configured for this provider */
  covers(provider: string): boolean;

  /** Resolve an email to a subject identifier, or null if not found */
  resolveEmail(provider: string, email: string): Promise<string | null>;

  /** Whether a subject still exists in the directory */
  subjectExists(provider: string, subject: string): Promise<boolean>;

  /** Number of members in a directory group, or null if unknown */
  groupSize(provider: string, groupId: string): Promise<number | null>;
}

/** Thrown when the directory cannot be reached */
export class DirectoryUnavailableError extends Error {
  constructor(
    readonly provider: string, // The provider whose directory failed
    readonly reason: string, // Machine-readable failure kind

    readonly detail = '', // Human-readable detail for the operator
  ) {
    super(`directory for "${provider}" is unavailable: ${reason}`);
    this.name = 'DirectoryUnavailableError';
  }
}

/** Result of resolving a PrincipalSet: deduplicated principals, next expiry, dropped grants */
export interface ResolvedGrants {
  principals: Principal[]; // Deduplicated and sorted list

  nextExpiry: Date | null; // Earliest expiry among all grants, null if none
  dropped: { principal: string; reason: string }[]; // Grants that were dropped
}

/** Context for resolving access grants: config, directory, source, now, policy flags */
export interface GrantContext {
  config: ConfigService; // Instance configuration
  directory?: DirectoryLookup; // External identity directory, if configured

  source: string; // Source file name for error reporting
  lineOf?: (keyPath: string) => number | null; // Maps config key to source line number
  now: Date; // Current time for expiry checks

  /** Not required for maintainers to allow permanent grants */
  requireUntil: boolean;

  expiryWarningMs: number; // Warn when a grant expires within this window

  publicGrant: PublicGrant; // Policy for the public group
}

/**
 * Policy for the `public` group
 *
 * 'enabled' allows it, 'disabled' blocks it for this repo, 'refused' rejects
 * public as a maintainer specifically
 */
export type PublicGrant = 'enabled' | 'disabled' | 'refused';

/**
 * Resolve a PrincipalSet into resolved principals
 *
 * Groups are resolved by name with special handling for the public group;
 * individual grants are resolved by subject or email with directory checks
 * and expiry validation. Results are deduplicated and sorted
 */
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
      /** Public is gated by instance policy rather than group membership */
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

/**
 * Resolve a single UserGrant into a principal
 *
 * Validates the provider, schema constraints (note required with subject,
 * until may be required), expiry, and directory membership. Returns null
 * and records a finding when the grant is invalid, expired, or unresolvable
 */
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

  /** Note provides a human-readable label for an opaque subject identifier */
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
      /** Grant has already expired — drop silently with an info finding */
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
    /** Magic-link subjects are emails — case-insensitive */
    const subject = kind === 'magic-link' ? grant.subject.toLowerCase() : grant.subject;
    if (ctx.directory?.covers(providerId)) {
      /** Assume the grant is still valid if the directory is unreachable */
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
      /** Magic-link uses email as the subject — no directory */
      return { principal: subjectPrincipal(providerId, email), until };
    }
    if (ctx.directory?.covers(providerId)) {
      /** undefined means the directory was unreachable — keep as email principal */
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

/**
 * Call the directory and return fallback on DirectoryUnavailableError
 *
 * When the directory is unreachable the grant is resolved as if no directory
 * was configured and an info finding is recorded for the operator
 */
async function askDirectory<T>(
  ask: () => Promise<T>,
  fallback: T,
  at: { ctx: GrantContext; findings: FindingList; line: number | undefined; where: string },
): Promise<T> {
  try {
    return await ask();
  } catch (err) {
    /** Re-throw unexpected errors; only directory unavailability is degraded */
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

/** Describe a UserGrant as a principal string for the dropped list */
function describeGrant(grant: UserGrant, providerId: string): string {
  if (grant.subject) return subjectPrincipal(providerId, grant.subject);
  if (grant.email) return emailPrincipal(providerId, grant.email);
  return `user:${providerId}:<unspecified>`;
}

/** Count expired and unresolved grants from a findings list */
export function findingsToDroppedGrants(findings: Finding[]): number {
  return findings.filter((f) => f.code === 'grant-expired' || f.code === 'grant-unresolved').length;
}
