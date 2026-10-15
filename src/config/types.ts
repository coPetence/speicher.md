import { Granularity } from '../dashboard/analytics/buckets';
import type { PaletteKey } from './palette';

export type ConfigSource = 'file' | 'database';

export interface SkippedConfigVersion {
  version: number;
  // Versions whose schema upgrade was skipped, recorded so the admin sees them
  problems: string[];
}

export interface MailConfig {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  from: string;
  reply_to?: string;
}

export interface DirectoryConfig {
  type: 'graph' | 'github';
  // graph
  tenant_id?: string;
  client_id?: string;
  client_secret?: string;
  // github
  app_id?: string;
  private_key?: string;
  cache_ttl?: string;
}

export interface OidcProviderConfig {
  type?: 'oidc';
  display_name?: string;
  issuer: string;
  client_id: string;
  client_secret?: string;
  subject_claim?: string;
  groups_claim?: string;
  email_claim?: string;
  domains?: string[];
  session_ttl?: string;
  directory?: DirectoryConfig;
}

export interface MagicLinkProviderConfig {
  type: 'magic-link';
  display_name?: string;
  token_ttl?: string;
  session_ttl?: string;
  same_browser?: boolean;
}

export interface GithubProviderConfig {
  type: 'github';
  display_name?: string;
  client_id: string;
  client_secret?: string;
  base_url?: string;
  session_ttl?: string;
  directory?: DirectoryConfig;
  app?: GithubProviderApp;
}


export interface GithubProviderApp {
  client_id: string;
  // The name of the App in its URLs, e.g. `speicher-md`
  slug: string;
  owner_account: string;
  owner_is_organization: boolean;
}

export type ProviderConfig = OidcProviderConfig | MagicLinkProviderConfig | GithubProviderConfig;

export function providerType(p: ProviderConfig): 'oidc' | 'magic-link' | 'github' {
  return p.type ?? 'oidc';
}

export interface GroupSource {
  provider: string;
  id?: string;
  domain?: string;
  subject?: string;
  email?: string;
  note?: string;
  until?: string;
}

export interface GitRepoConfig {
  // A named repo inside a forge, referenced by id in a SpeicherConfig
  id: string;
  url: string;
  slug?: string;
  branch?: string;
  deploy_key?: string;
  token?: string;
  username?: string;
  poll_interval?: string;
}

/**
 * gitRepositoryOwner returns the user or organization a plain git repository belongs
 * to: the path of its remote URL without the repository name, for example `acme` for
 * `https://host/acme/docs.git` and `acme/team` for `https://host/acme/team/docs.git`.
 * It returns null if the path holds no owner.
 *
 * @param repo the repository
 */
export function gitRepositoryOwner(repo: GitRepoConfig): string | null {
  try {
    const segments = new URL(repo.url).pathname
      .replace(/\.git\/?$/, '')
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
    return segments.length > 1 ? segments.slice(0, -1).join('/') : null;
  } catch {
    return null;
  }
}

export interface ForgeConfig {
  type: 'github' | 'gitlab' | 'gitea' | 'forgejo' | 'git';
  primary?: boolean;
  default_repository_owner?: string;
  base_url?: string;
  webhook_secret?: string;
  app_id?: string;
  private_key?: string;
  token?: string;
  // Overrides the forge-level poll_interval for repos that do not set their own
  poll_interval?: string;
  known_hosts?: string;
  repos?: GitRepoConfig[];
}

export const MIN_POLL_INTERVAL = '1m';
export const DEFAULT_POLL_INTERVAL = '1h';

export interface UserGrant {
  provider?: string;
  subject?: string;
  email?: string;
  note?: string;
  until?: string;
}

export interface PrincipalSet {
  groups?: string[];
  users?: UserGrant[];
}

export interface SyncConfig {
  include?: string[];
  exclude?: string[];
}

export interface RetrievalConfig {
  indexable?: boolean;
}

export interface AssetsConfig {
  driver: 'filesystem' | 's3' | 'azure';
  path?: string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  access_key_id?: string;
  secret_access_key?: string;
  account?: string;
  container?: string;
  connection_string?: string;
  account_key?: string;
  // Azure Blob auth method; defaults to 'connection_string' when connection_string is set
  auth?: 'connection_string' | 'key' | 'managed_identity' | 'workload_identity' | 'default';
  client_id?: string;
  tenant_id?: string;
  max_asset_bytes?: number;
  presign_over_bytes?: number;
  presign_ttl?: string;
}

export interface NotifyConfig {
  sync_failure?: ('admins' | 'maintainers' | 'committer')[];
  stale?: ('admins' | 'maintainers')[];
  grant_expiry?: ('admins' | 'maintainers')[];
  stale_after?: string;
  expiry_warning?: string;
}

export interface EmbeddingConfig {
  base_url: string;
  api_key?: string;
  model: string;
  dimensions: number;
  send_dimensions?: boolean;
  batch_size?: number;
  max_concurrency?: number;
}

export type PaletteConfig = Partial<Record<PaletteKey, string>>;

export interface ThemeConfig {
  template?: string;
  font?: string;
  palette?: {
    light?: PaletteConfig;
    dark?: PaletteConfig;
  };
}

export interface GraphConfig {
  enabled?: boolean;
  related?: boolean;
  previews?: boolean;
  terms?: boolean;
  search_boost?: boolean;
  related_limit?: number;
}

export interface AnalyticsConfig {
  enabled?: boolean;
  // Timezone for daily/weekly/monthly bucket alignment, defaults to UTC
  timezone?: string;
  granularity?: Granularity;
  unique_readers?: boolean;
  public_beacon?: boolean;
  retention_days?: number;
  search_retention_days?: number;
}

export interface BrandConfig {
  name?: string;
  // Logo for light mode
  logo?: string;
  // Logo for dark mode
  logo_dark?: string;
  // Favicon: square, PNG or SVG
  icon?: string;
  // Whether to show the brand name next to the logo in the header
  show_name?: boolean;
  // How the brand name lines up with the logo beside it
  name_align?: BrandNameAlign;
}

export type BrandNameAlign = 'center' | 'bottom';

export interface PublicConfig {
  repos: string[];
}

export interface InstanceConfig {
  version: 1;
  mail?: MailConfig;
  assets?: AssetsConfig;
  theme?: ThemeConfig;
  // Whether to show "Powered by Speicher" in the footer; defaults to true
  attribution?: boolean;
  // Brand config for the top-level site (not per-repo)
  brand?: BrandConfig;
  graph?: GraphConfig;
  // Analytics tracking, including Plausible-style public beacon
  analytics?: AnalyticsConfig;
  notify?: NotifyConfig;
  embedding?: EmbeddingConfig;
  // Auth providers: keyed by provider name, one is the default
  auth?: {
    default_provider?: string;
    providers: Record<string, ProviderConfig>;
  };
  // Global admins and maintainers, applies to all repos
  admins?: PrincipalSet;
  // Groups of principals keyed by group name, referenced from SpeicherConfig
  groups?: Record<string, GroupSource[]>;
  // Repos visible without authentication
  public?: PublicConfig;
  // Forge connections, keyed by forge name
  forges?: Record<string, ForgeConfig>;
  defaults?: {
    sync?: SyncConfig;
    retrieval?: RetrievalConfig;
    display?: { cover?: string | null };
  };
}

export interface SpeicherConfig {
  version?: 1;
  ingest_root?: string;
  access?: string[] | PrincipalSet;
  maintainers?: PrincipalSet;
  display?: { title?: string; cover?: string | null };
  retrieval?: RetrievalConfig;
  sync?: SyncConfig;
}

export interface Frontmatter {
  title?: string;
  description?: string;
  // Lucide icon name, kebab-case used as the document icon in navigation
  icon?: string;
  redirect_from?: string[];
  draft?: boolean;
  indexable?: boolean;
  // Tags used for filtering and search faceting
  tags?: string[];
  // Sidebar sort position (lower = higher); overrides sidebar.order
  sidebar_position?: number;
  sidebar?: { order?: number; [key: string]: unknown };
}

export function normalizeAccess(access: SpeicherConfig['access']): PrincipalSet | undefined {
  if (access === undefined) return undefined;
  if (Array.isArray(access)) return { groups: access };
  return access;
}

export const SYNC_DEFAULTS: Required<SyncConfig> = {
  include: ['**/*.md'],
  exclude: ['**/README.md'],
};

export const NEUTRAL_BRAND = 'Documentation';
