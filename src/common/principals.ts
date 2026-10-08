/**
 * Identity principals for authorization
 *
 * A principal is a string identifying an actor in the authorization model
 * Format: group:{name}, user:{provider}:{subject} or
 *   user:{provider}:email:{email}
 *
 * Every caller, even unauthenticated, receives PUBLIC_PRINCIPAL
 * SETUP_PROVIDER is reserved: it names the session that claims an
 *   unconfigured instance
 */

export type Principal = string;

/** Build a group principal from an internal group name */
export function groupPrincipal(internalName: string): Principal {
  return `group:${internalName}`;
}

/** Reserved group name given to every caller, including unauthenticated ones */
export const PUBLIC_GROUP_NAME = 'public';
/** The Principal for the public group */
export const PUBLIC_PRINCIPAL: Principal = groupPrincipal(PUBLIC_GROUP_NAME);

/** Reserved provider name for the session that claims an unconfigured instance */
export const SETUP_PROVIDER = 'setup';

/** Build a user principal from a provider and subject identifier */
export function subjectPrincipal(provider: string, subject: string): Principal {
  return `user:${provider}:${subject}`;
}

/** Build a user principal from a provider and email address */
export function emailPrincipal(provider: string, email: string): Principal {
  return `user:${provider}:email:${email.toLowerCase()}`;
}

/** A parsed principal broken into its structured components */
export type ParsedPrincipal =
  | { kind: 'group'; name: string }
  | { kind: 'subject'; provider: string; subject: string }
  | { kind: 'email'; provider: string; email: string };

/**
 * Parse a Principal string into its structured components
 *
 * The email form is detected by the literal `email:` after provider, not by
 * treating the third colon as the separator: subject values may contain colons
 */
export function parsePrincipal(principal: Principal): ParsedPrincipal | null {
  if (principal.startsWith('group:')) {
    const name = principal.slice('group:'.length);
    return name ? { kind: 'group', name } : null;
  }
  if (!principal.startsWith('user:')) return null;
  const rest = principal.slice('user:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const provider = rest.slice(0, sep);
  const tail = rest.slice(sep + 1);
  if (tail.startsWith('email:')) {
    const email = tail.slice('email:'.length);
    return email ? { kind: 'email', provider, email } : null;
  }
  return tail ? { kind: 'subject', provider, subject: tail } : null;
}

/** Deduplicate and sort a list of principals */
export function normalizePrincipals(principals: Iterable<Principal>): Principal[] {
  return [...new Set(principals)].sort();
}

/** Intersect two principal lists, returning the normalized common subset */
export function intersectPrincipals(parent: Principal[], child: Principal[]): Principal[] {
  const childSet = new Set(child);
  return normalizePrincipals(parent.filter((p) => childSet.has(p)));
}

/** True if any principal appears in both lists */
export function principalsOverlap(a: Principal[], b: Principal[]): boolean {
  const set = new Set(a);
  return b.some((p) => set.has(p));
}
