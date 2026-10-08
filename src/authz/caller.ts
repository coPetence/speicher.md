import {
  PUBLIC_PRINCIPAL,
  Principal,
  emailPrincipal,
  groupPrincipal,
  normalizePrincipals,
  principalsOverlap,
  subjectPrincipal,
} from '../common/principals';

/**
 * Caller identity and authorisation
 *
 * A caller is one HTTP request: anonymous, a signed-in session, or a bearer token
 * Authorisation is overlap between the caller's principals and the configured admins
 * or a repo's maintainers
 *
 * Bearer tokens (API keys, OAuth access tokens) carry only read scope, so a bearer
 * caller is never admin or maintainer
 */
/** Identity of a signed-in user as claimed by the provider */
export interface CallerIdentity {
  provider: string;

  subject: string;
  email: string | null;
  displayName?: string | null;
}

/** A request as identified by the caller middleware */
export interface Caller {
  tenantId: string;

  identity: CallerIdentity | null; // Null for anonymous requests

  rawGroupIds: string[]; // Group ids as claimed by the provider

  viaBearer: boolean; // Authenticated by an API key or OAuth access token

  viaSetup?: boolean; // Setup session, administers its tenant
}

/** Caller with groups, principals and admin status resolved */
export interface ResolvedCaller extends Caller {
  principals: Principal[]; // Deduped and sorted

  internalGroups: string[]; // Configured group names the claimed ids matched

  isAdmin: boolean;
}

/** Caller for requests with no identity, tenant filled in at resolution */
export const ANONYMOUS: Omit<Caller, 'tenantId'> = {
  identity: null,
  rawGroupIds: [],
  viaBearer: false,
};

/** Principals a caller holds: public, subject, email, and each internal group */
export function principalsFor(
  identity: CallerIdentity | null,
  internalGroups: string[],
): Principal[] {
  const principals: Principal[] = [PUBLIC_PRINCIPAL];
  if (!identity) return principals;
  principals.push(subjectPrincipal(identity.provider, identity.subject));
  if (identity.email) principals.push(emailPrincipal(identity.provider, identity.email));
  for (const group of internalGroups) principals.push(groupPrincipal(group));
  return normalizePrincipals(principals);
}

/**
 * Whether the caller is an instance admin
 *
 * Setup sessions are admin, not a principal check: the bootstrap runs before admins exist
 * Otherwise: overlap with the configured admin principals
 */
export function isAdminCaller(
  principals: Principal[],
  adminPrincipals: Principal[],
  viaBearer: boolean,
  viaSetup = false,
): boolean {
  if (viaBearer) return false;

  if (viaSetup) return true;
  return principalsOverlap(principals, adminPrincipals);
}

/** Whether the caller may maintain a repo */
export function isMaintainerOf(
  principals: Principal[],
  repoMaintainerPrincipals: Principal[],
  viaBearer: boolean,
): boolean {
  if (viaBearer) return false;
  return principalsOverlap(principals, repoMaintainerPrincipals);
}
