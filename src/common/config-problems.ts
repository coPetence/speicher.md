/** Configuration problems with stable codes and audience-specific messages */

/** Problem codes */
export const PROBLEM_CODES = [
  // Document-level failures
  'config.unreadable',
  'config.yaml-invalid',
  'config.schema',
  'config.env-missing',
  'config.inconsistent',
  'config.no-version-loads',
  'config.version-conflict',
  'config.private-key-unreadable',
  'config.host-key-missing',
  'config.source-invalid',
  'config.export-unparseable',
  'env.unset',
  'names.reserved',
  'names.case-collision',
  'admins.none',
  'admins.group-empty',
  'admins.unknown-group',
  'admins.user-no-provider',
  'admins.user-ambiguous-provider',
  'admins.unknown-provider',
  'providers.magic-link-needs-mail',
  'providers.unknown-default',
  'providers.client-secret-missing',
  'providers.directory-wrong-type',
  'providers.directory-foreign-key',
  'providers.directory-key-missing',
  'providers.directory-needs-oid',
  'groups.unknown-provider',
  'groups.domain-needs-magic-link',
  'groups.id-with-magic-link',
  'groups.github-team-invalid',
  'groups.until-invalid',
  'groups.address-on-multi-tenant',
  'groups.self-reference',
  'groups.unknown-reference',
  'groups.reference-cycle',
  'brand.image-invalid',
  'brand.image-not-stored',
  'analytics.timezone-unknown',
  'forges.primary-ambiguous',
  'forges.primary-missing',
  'forges.segment-reserved',
  'forges.segment-taken',
  'forges.repos-on-non-git',
  'forges.webhook-secret-on-git',
  'forges.app-key-on-git',
  'forges.poll-interval-too-short',
  'forges.repo-id-taken',
  'forges.repo-url-no-owner',
  'forges.repo-slug-empty',
  'forges.repo-slug-taken',
  'forges.ssh-needs-deploy-key',
  'forges.ssh-needs-known-hosts',
  'forges.token-on-ssh',
  'forges.https-needs-token',
  'forges.deploy-key-on-https',
  'forges.host-key-missing',
  'github.private-key-unreadable',
  'assets.misconfigured',
  'assets.key-missing',
  'assets.auth-unknown',
  'azure.credential-unavailable',
  'azure.credential-unknown-kind',
] as const;

/** Schema codes use the failed keyword, such as `schema.required` */
export type ProblemCode = (typeof PROBLEM_CODES)[number] | `schema.${string}`;

/** Message audience */
export type ProblemAudience = 'yaml' | 'dashboard';

export interface ConfigProblem {
  code: ProblemCode;
  /** Affected key, such as `admins.users[0]`; null for instance-wide problems */
  path: string | null;
  /** YAML message; may name keys but must not include links */
  text: string;
  /** Optional dashboard message avoiding keys absent from forms */
  dashboard?: string;
  /** Facts the wording is built from, such as a variable name, for callers that need them */
  facts?: Record<string, string>;
}

export function problem(
  code: ProblemCode,
  path: string | null,
  wording: { text: string; dashboard?: string; facts?: Record<string, string> },
): ConfigProblem {
  return { code, path, ...wording };
}

/** Prefix YAML messages with the path; use as fallback for dashboard messages */
export function wordingFor(p: ConfigProblem, audience: ProblemAudience): string {
  const yaml = p.path ? `${p.path}: ${p.text}` : p.text;
  return audience === 'dashboard' ? (p.dashboard ?? yaml) : yaml;
}
