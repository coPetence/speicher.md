import { Granularity } from '../dashboard/analytics/buckets';
import type { PaletteKey } from './palette';
import type { ConfigProblem } from '../common/config-problems';

export type ConfigSource = 'file' | 'database';

export interface SkippedConfigVersion {
  version: number;
  // Schema upgrade problems shown to admins
  problems: string[];
  // Coded config issues
  issues: ConfigProblem[];
}

export interface MailConfig {
  host: string;
  port?: number;
  username?: string;
  password?: string;
  from?: string;
  reply_to?: string;
}

export interface DirectoryConfig {
  type: 'graph' | 'github';
  // Microsoft Graph
  tenant_id?: string;
  client_id?: string;
  client_secret?: string;
  // GitHub
  app_id?: string;
  private_key?: string;
  webhook_secret?: string;
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
  connection_idle_ttl?: string;
  directory?: DirectoryConfig;
}

export interface MagicLinkProviderConfig {
  type: 'magic-link';
  display_name?: string;
  token_ttl?: string;
  session_ttl?: string;
  same_browser?: boolean;
  domains?: string[];
}

export interface GithubProviderConfig {
  type: 'github';
  display_name?: string;
  client_id: string;
  client_secret?: string;
  base_url?: string;
  session_ttl?: string;
  connection_idle_ttl?: string;
  domains?: string[];
  directory?: DirectoryConfig;
  app?: GithubProviderApp;
}

export interface GithubProviderApp {
  client_id: string;
  // App URL slug, e.g. `speicher-md`
  slug: string;
  owner_account: string;
  owner_is_organization: boolean;
  // Whether anyone with a GitHub account can sign in; absent when the App was not created by Speicher.md
  public?: boolean;
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

/** Reference to another group */
export interface GroupReference {
  group: string;
  note?: string;
  until?: string;
}

export type GroupItem = GroupSource | GroupReference;

export function isGroupReference(item: GroupItem): item is GroupReference {
  return 'group' in item && typeof (item as GroupReference).group === 'string';
}

export interface GitRepoConfig {
  // Forge repo ID referenced by SpeicherConfig
  id: string;
  url: string;
  slug?: string;
  branch?: string;
  deploy_key?: string;
  token?: string;
  username?: string;
  poll_interval?: string;
}

/** Returns the URL path without the repo name, or null if invalid or ownerless */
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
  // Default poll interval for repos without an override
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
  // Azure auth; defaults to 'connection_string' when set
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
  rounded_corners?: boolean;
  tui?: boolean;
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
  // Daily, weekly and monthly bucket timezone; defaults to UTC
  timezone?: string;
  granularity?: Granularity;
  unique_readers?: boolean;
  public_beacon?: boolean;
  retention_days?: number;
  search_retention_days?: number;
}

export interface BrandConfig {
  name?: string;
  // Light-mode logo
  logo?: string;
  // Dark-mode logo
  logo_dark?: string;
  // Square PNG or SVG favicon
  icon?: string;
  // Page background wallpaper
  wallpaper?: string;
  // Dark-mode wallpaper
  wallpaper_dark?: string;
  // Show wallpaper in all themes, not just Glass
  wallpaper_all_themes?: boolean;
  // Show brand name beside the header logo
  show_name?: boolean;
  // Brand name alignment beside the logo
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
  // Show "Powered by Speicher" in the footer; defaults to true
  attribution?: boolean;
  // Site-wide branding, not per-repo
  brand?: BrandConfig;
  graph?: GraphConfig;
  // Analytics tracking and Plausible-style public beacon
  analytics?: AnalyticsConfig;
  notify?: NotifyConfig;
  embedding?: EmbeddingConfig;
  // Named auth providers with a default
  auth?: {
    default_provider?: string;
    providers: Record<string, ProviderConfig>;
  };
  // Admins across all repos
  admins?: PrincipalSet;
  // Named groups; any matching item grants membership
  groups?: Record<string, GroupItem[]>;
  // Repos accessible without authentication
  public?: PublicConfig;
  // Forge connections by name
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
  // Kebab-case Lucide icon name for navigation
  icon?: string;
  redirect_from?: string[];
  draft?: boolean;
  indexable?: boolean;
  // Filter and search facet tags
  tags?: string[];
  // Sidebar order: lower first; overrides sidebar.order
  sidebar_position?: number;
  sidebar?: { order?: number; [key: string]: unknown };
}

export function normalizeAccess(access: SpeicherConfig['access']): PrincipalSet | undefined {
  if (access === undefined) return undefined;
  if (Array.isArray(access)) return { groups: access };
  return access;
}

export const SYNC_DEFAULTS: Required<SyncConfig> = {
  include: [
    '**/*.md',
    '**/*.mdx',
    '**/*.png',
    '**/*.jpg',
    '**/*.jpeg',
    '**/*.gif',
    '**/*.webp',
    '**/*.avif',
    '**/*.svg',
  ],
  exclude: ['**/README.md'],
};

export const NEUTRAL_BRAND = 'Documentation';
