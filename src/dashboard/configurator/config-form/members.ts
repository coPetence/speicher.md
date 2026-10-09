/**
 * Members: what a URL segment addresses, and what a new one starts as
 *
 * A collection whose entries cannot be named in advance — a provider, a group,
 * a content source, an administrator — is reached by a section id like
 * `identity/entra` or `admins/0`. `MEMBER_COLLECTIONS` is the one list saying
 * which those are; everything else here turns a section id into a document
 * path and back, or says what a member of a given kind is created as
 *
 * None of it builds a field, which is why `config.controller.ts` can route
 * every member page without reaching for a section builder. It also means the
 * kind registries live here: `MEMBER_COLLECTIONS` names the kinds a collection
 * accepts, and a seed is written per kind
 */

import { scalarString } from './document';
import { at, entraTenantOf } from './config-fields';
import type { Obj } from './config-fields';
import type { Option } from './model';

export interface ProviderKind {
  // Internal value used in the form and config
  value: string;
  label: string;
  // The config object type this maps to
  type: string;
  // Brand mark identifier shown alongside the option
  mark: string;
}

export const PROVIDER_KINDS: ProviderKind[] = [
  {
    value: 'entra',
    label: 'Microsoft Entra ID',
    type: 'oidc',
    mark: 'microsoft',
  },
  { value: 'oidc', label: 'OpenID Connect', type: 'oidc', mark: 'openid' },
  {
    value: 'magic-link',
    label: 'Magic link (email)',
    type: 'magic-link',
    mark: 'mail',
  },
  { value: 'github', label: 'GitHub', type: 'github', mark: 'github' },
];

export interface KindHint {
  provider: string;
  kind: string;
}

export function kindOf(value: string): ProviderKind | undefined {
  return PROVIDER_KINDS.find((kind) => kind.value === value);
}

export const SHORT_ID = new RegExp('^[A-Za-z0-9][A-Za-z0-9\\-]{0,31}$');
export const SHORT_ID_HINT =
  'Letters, digits and hyphens, starting with a letter or digit. Up to 32 characters';

/**
 * Produce the initial config fields for a new provider of the given kind
 */
export function seedProvider(kind: string): Record<string, string> {
  const entry = kindOf(kind);
  if (!entry) return {};
  if (entry.value !== 'entra') return { type: entry.type };
  return {
    type: entry.type,
    subject_claim: 'oid',
    groups_claim: 'groups',
    email_claim: 'preferred_username',
  };
}

/**
 * Produce the initial config fields for a new forge of the given kind
 */
export function seedForge(kind: string): Record<string, unknown> {
  const type = FORGE_TYPES.some((entry) => entry.value === kind) ? kind : 'github';
  return type === 'git' ? { type, repos: [{}] } : { type };
}

/**
 * Produce the initial config value when creating a new member
 */
export function seedMember(ref: MemberRef, kind: string): unknown {
  // List-based members start as empty objects
  if (memberPosition(ref)) return {};
  const section = ref.section;
  if (section === 'identity') return seedProvider(kind);
  if (section === 'sources') return seedForge(kind);
  // Group sources are stored as an array of objects
  if (section === 'groups') return [];
  return undefined;
}

/**
 * Whether a member of the given kind can be created at the given reference
 */
export function canCreateMember(ref: MemberRef, kind: string | undefined): boolean {
  const collection = memberCollectionOf(ref.section);
  if (!collection) return false;
  // Entry-level creation requires an entry noun
  if (ref.entry !== null) return collection.entryNoun !== undefined;
  // List members can always be appended
  if (memberPosition(ref)) return true;
  // Map members need a kind when the collection has kinds
  if (collection.kinds) return kind !== undefined && collection.kinds.values.includes(kind);
  return true;
}

export interface MemberCollection {
  // The config section this collection belongs to
  section: string;
  // Path from root to the collection in the config document
  path: string[];
  // Whether items are keyed by id (map) or numeric index (list)
  kind: 'map' | 'list';
  // Regex that member ids must match
  pattern: RegExp;
  // Produces a principal pattern for grant matching; null when not applicable
  principalPattern?: (id: string) => string;
  // Options for kinds of members that can be created in this collection
  kinds?: { values: string[]; fallback: string };
  // Name for the collection
  noun: string;
  // Name for entries within a member
  entryNoun?: string;
  // Regex that entry ids must match
  entryPattern?: RegExp;
}

export const GROUP_NAME = new RegExp('^[A-Za-z0-9][A-Za-z0-9\\-]{0,63}$');
export const GROUP_NAME_HINT =
  'Letters, digits and hyphens, starting with a letter or digit. Up to 64 characters.';

/*
  One field, two tooltips: a provider's id is never shown to anybody signing in,
  whereas a group's name is only ever referenced from a repository's `.speicher.yaml`.
  A group's is shown wherever its name is typed, so the add popup and the group's
  own page cannot word it differently.
*/
export const PROVIDER_ID_HELP =
  'The id repositories grant access with. Never shown to anybody signing in — that is **Name**.';
export const GROUP_ID_HELP =
  'The name repositories grant access with, in their `.speicher.yaml`. Nobody signing in sees it.';

export const FORGE_TYPES: Option[] = [
  { value: 'github', label: 'GitHub App', mark: 'github' },
  { value: 'git', label: 'Plain git remote', mark: 'git' },
  { value: 'gitlab', label: 'GitLab', mark: 'gitlab' },
  { value: 'gitea', label: 'Gitea', mark: 'gitea' },
  { value: 'forgejo', label: 'Forgejo', mark: 'forgejo' },
];

/** What a forge kind is called, falling back to the stored word itself */
export function forgeLabel(type: string): string {
  return FORGE_TYPES.find((entry) => entry.value === type)?.label ?? type;
}

/**
 * Which mark a forge kind is drawn with, and the one place that decides.
 *
 * Read by the configuration pages, which name a kind an operator picked, and by
 * `/-/status`, which names the kind a materialised repository *came from* — two
 * surfaces where the same source must be the same picture, so the answer is not
 * asked twice. A kind with no mark answers the empty string, which every caller
 * reads as "draw none".
 */
export function forgeMark(type: string | null): string {
  return FORGE_TYPES.find((entry) => entry.value === type)?.mark ?? '';
}

// Matches numeric position strings for list-based collections
const POSITION = /^\d+$/;

export const MEMBER_COLLECTIONS: MemberCollection[] = [
  {
    section: 'identity',
    path: ['auth', 'providers'],
    kind: 'map',
    pattern: SHORT_ID,
    // Principal pattern: user:<provider>:%
    principalPattern: (id) => `user:${id}:%`,
    noun: 'provider',
    // One of the PROVIDER_KINDS values
    kinds: {
      values: PROVIDER_KINDS.map((entry) => entry.value),
      fallback: 'oidc',
    },
  },
  {
    section: 'groups',
    path: ['groups'],
    kind: 'map',
    pattern: GROUP_NAME,
    // Principal pattern: group:<name>
    principalPattern: (id) => `group:${id}`,
    noun: 'group',
    entryNoun: 'source',
    // Entries within a group have short ids
    entryPattern: SHORT_ID,
  },
  {
    section: 'sources',
    path: ['forges'],
    kind: 'map',
    pattern: SHORT_ID,
    noun: 'source',
    // One of the FORGE_TYPES values
    kinds: {
      values: FORGE_TYPES.map((entry) => entry.value),
      fallback: 'github',
    },
  },
  {
    section: 'admins',
    path: ['admins', 'users'],
    // Admin users are stored as a list indexed by position
    kind: 'list',
    pattern: POSITION,
    noun: 'administrator',
  },
];

/**
 * Find a free member id by appending a counter to the base
 */
export function freeMemberId(taken: string[], base: string): string {
  if (!taken.includes(base)) return base;
  for (let n = 2; n <= taken.length + 1; n += 1) {
    if (!taken.includes(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${taken.length + 2}`;
}

/**
 * Produce a principal pattern suitable for grant matching
 */
export function memberPrincipalPattern(section: string, id: string): string | null {
  // Not all sections have a principal pattern
  return memberCollectionOf(section)?.principalPattern?.(id) ?? null;
}

export function memberCollectionOf(section: string): MemberCollection | undefined {
  return MEMBER_COLLECTIONS.find((entry) => entry.section === section);
}

/**
 * Build a section id from its parts
 */
export function memberSectionId(section: string, id: string, entry?: string): string {
  return entry === undefined ? `${section}/${id}` : `${section}/${id}/${entry}`;
}

export interface MemberRef {
  section: string;
  id: string;
  // Entry id within a member; null when the member itself is referenced
  entry: string | null;
}

/**
 * Parse a section id into its component parts
 */
export function memberOf(sectionId: string): MemberRef | null {
  const [section, id, position, ...rest] = sectionId.split('/');
  if (rest.length > 0 || id === undefined) return null;

  const collection = memberCollectionOf(section);
  if (!collection || !collection.pattern.test(id)) return null;
  if (position === undefined) return { section, id, entry: null };
  // List-based collections do not have entries within them
  if (collection.kind === 'list') return null;

  if (!collection.entryNoun || !collection.entryPattern?.test(position)) return null;
  return { section, id, entry: position };
}

/**
 * Whether the given id matches the pattern for the given section
 */
export function isMemberId(section: string, id: string): boolean {
  return memberCollectionOf(section)?.pattern.test(id) ?? false;
}

/**
 * Human-readable name for a member in the given section
 */
export function nounOf(section: string): string {
  return memberCollectionOf(section)?.noun ?? '';
}

/**
 * Resolve a member reference to its path in the config document
 */
export function memberPath(ref: MemberRef): (string | number)[] {
  const collection = memberCollectionOf(ref.section);
  if (!collection) return [];
  // List collections use numeric indices; map collections use string keys
  return [...collection.path, collection.kind === 'list' ? Number(ref.id) : ref.id];
}

/**
 * Find all source positions within a group that reference the given provider
 */
export function sourcePositions(root: Obj, name: string, provider: string): number[] {
  const sources = (at(root, ['groups', name]) as unknown[]) ?? [];
  const out: number[] = [];
  sources.forEach((source, index) => {
    if (scalarString(((source ?? {}) as Obj).provider) === provider) out.push(index);
  });
  return out;
}

/**
 * Get the list path and position for a list-based member reference
 */
export function memberPosition(ref: MemberRef): { list: (string | number)[]; at: number } | null {
  const collection = memberCollectionOf(ref.section);
  if (!collection || collection.kind !== 'list') return null;
  return { list: [...collection.path], at: Number(ref.id) };
}

/**
 * Build a config page URL for the given member name and kind
 */
export function entryHrefFor(sectionId: string, name: string, kind: string): string | null {
  const id = name.trim();

  const parent = memberOf(sectionId);
  if (parent && parent.entry === null) {
    const owner = memberCollectionOf(parent.section);
    if (!owner?.entryPattern?.test(id)) return null;
    return `/-/config/${memberSectionId(parent.section, parent.id, id)}`;
  }

  const collection = memberCollectionOf(sectionId);
  if (!collection) return null;
  if (!collection.pattern.test(id)) return null;

  const href = `/-/config/${memberSectionId(sectionId, id)}`;
  const kinds = collection.kinds;
  if (!kinds) return href;
  return `${href}?kind=${kinds.values.includes(kind) ? kind : kinds.fallback}`;
}

/**
 * Which members a document holds, and what kind each one is
 *
 * `providerFormKind` is where the virtual `entra` kind is decided — it is
 * recognised by the shape of the issuer and never stored, so every surface that
 * asks a provider's kind has to ask it here rather than read `type`
 */

export function providerIds(root: Obj): string[] {
  return Object.keys((at(root, ['auth', 'providers']) as Obj) ?? {});
}

export function providerType(root: Obj, id: string): string {
  const provider = at(root, ['auth', 'providers', id]) as Obj | undefined;
  // Default to oidc when the type is missing (legacy configs)
  return typeof provider?.type === 'string' ? provider.type : 'oidc';
}

// Excludes common, organizations and consumers as they cannot be pinned
export const ENTRA_TENANT_PATTERN =
  '(?!common$|organizations$|consumers$)[A-Za-z0-9][A-Za-z0-9.\\-]{2,63}';
export const ENTRA_TENANT_HINT =
  'A directory GUID or verified domain. Not common, organizations or consumers.';

export function providerFormKind(root: Obj, id: string, hint?: KindHint): string {
  const type = providerType(root, id);
  if (type !== 'oidc') return type;

  const issuer = scalarString(at(root, ['auth', 'providers', id, 'issuer']));
  if (entraTenantOf(issuer) !== null) return 'entra';

  // When the issuer is empty and a hint is provided, use the hinted kind
  if (issuer === '' && hint?.provider === id) return hint.kind;

  return 'oidc';
}

/**
 * The mark for a provider the instance is *running*, read off its loaded config
 *
 * `providerMark` above reads the stored YAML document, which is what the
 * configurator has in hand. The sign-in page has the loaded config instead, and
 * the two must agree on the one question that decides a logo — an Entra tenant is
 * recognised by the shape of its issuer in both — so the virtual `entra` kind is
 * decided here by the same `entraTenantOf`. A kind with no mark is '', and the
 * caller draws no logo rather than an empty box
 */
export function providerMarkOf(provider: { type?: string; issuer?: string }): string {
  const type = provider.type ?? 'oidc';
  const kind = type === 'oidc' && entraTenantOf(provider.issuer ?? '') !== null ? 'entra' : type;
  return kindOf(kind)?.mark ?? '';
}

export function providerMark(root: Obj, id: string): string {
  if (id === '' || at(root, ['auth', 'providers', id]) === undefined) return '';
  return kindOf(providerFormKind(root, id))?.mark ?? '';
}

export function groupNames(root: Obj): string[] {
  return Object.keys((at(root, ['groups']) as Obj) ?? {});
}

export function groupProviders(root: Obj, name: string): string[] {
  const sources = (at(root, ['groups', name]) as unknown[]) ?? [];
  const out: string[] = [];
  for (const source of sources) {
    const provider = scalarString(((source ?? {}) as Obj).provider);
    if (!out.includes(provider)) out.push(provider);
  }
  return out;
}

export function forgeIds(root: Obj): string[] {
  return Object.keys((at(root, ['forges']) as Obj) ?? {});
}

export function forgeType(root: Obj, id: string): string {
  return scalarString(at(root, ['forges', id, 'type']));
}
