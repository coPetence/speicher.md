/**
 * Runtime config accessor with defaults and caching
 *
 * Wraps loaded instance config behind typed getters
 * Replaced atomically on hot reload via adopt()
 * Caches parsed logo and theme CSS, invalidated on config
 * Sub-features in graph and analytics are gated on parent enabled
 */
import { Injectable } from '@nestjs/common';

import { env } from '../common/env';
import { emailPrincipal, groupPrincipal, Principal, subjectPrincipal } from '../common/principals';
import { slugify } from '../common/slug';
import { isExpired } from '../common/until';
import {
  BRAND_ICON,
  BRAND_IMAGES,
  BRAND_LOGO,
  BRAND_LOGO_DARK,
  BrandImage,
  BrandImageSpec,
  brandImageUrl,
} from './brand';
import { pollIntervalMs } from './checks/git-forges';
import type { ColourScheme } from './palette';
import { themeOverrides } from './palette';
import { LoadedInstanceConfig } from './parser';
import {
  AnalyticsConfig,
  AssetsConfig,
  ConfigSource,
  EmbeddingConfig,
  ForgeConfig,
  GitRepoConfig,
  GraphConfig,
  GroupSource,
  InstanceConfig,
  NEUTRAL_BRAND,
  NotifyConfig,
  ProviderConfig,
  providerType,
  SkippedConfigVersion,
  SYNC_DEFAULTS,
  SyncConfig,
  ThemeConfig,
} from './types';

export interface RepoRef {
  namespace: string;
  slug: string;
}

@Injectable()
export class ConfigService {
  private loaded: LoadedInstanceConfig;

  private themeSource: ThemeConfig | undefined;
  private readonly themeCache = new Map<string, string | null>();

  constructor(loaded: LoadedInstanceConfig) {
    this.loaded = loaded;
  }

  /** Hot-reload the config atomically */
  adopt(next: LoadedInstanceConfig): void {
    this.loaded = next;
  }

  get instance(): InstanceConfig {
    return this.loaded.raw;
  }

  get loadedConfig(): LoadedInstanceConfig {
    return this.loaded;
  }

  get sourcePath(): string | null {
    return this.loaded.sourcePath;
  }

  get configSource(): ConfigSource {
    return this.loaded.source;
  }

  get configVersion(): number | null {
    return this.loaded.version;
  }

  get skippedConfigVersions(): SkippedConfigVersion[] {
    return this.loaded.skipped;
  }

  get resolutionHash(): string {
    return this.loaded.resolutionHash;
  }

  get hasAdministrator(): boolean {
    return this.adminPrincipals().length > 0;
  }

  get hasContentSource(): boolean {
    return Object.keys(this.instance.forges ?? {}).length > 0;
  }

  get primaryForgeId(): string | null {
    return this.loaded.primaryForgeId;
  }

  get forgeIds(): string[] {
    return Object.keys(this.instance.forges ?? {});
  }

  forge(id: string): ForgeConfig | undefined {
    return this.instance.forges?.[id];
  }

  defaultRepositoryOwnerFor(forgeId: string): string | undefined {
    return this.forge(forgeId)?.default_repository_owner;
  }

  get gitForgeIds(): string[] {
    return this.forgeIds.filter((id) => this.forge(id)?.type === 'git');
  }

  gitRepos(forgeId: string): GitRepoConfig[] {
    const forge = this.forge(forgeId);
    return forge?.type === 'git' ? (forge.repos ?? []) : [];
  }

  gitRepo(forgeId: string, repoId: string): GitRepoConfig | undefined {
    return this.gitRepos(forgeId).find((repo) => repo.id === repoId);
  }

  pollIntervalMs(forgeId: string, repoId: string): number | null {
    const forge = this.forge(forgeId);
    const repo = this.gitRepo(forgeId, repoId);

    return forge && repo ? pollIntervalMs(forge, repo) : null;
  }

  get minPollIntervalMs(): number | null {
    const intervals = this.gitForgeIds.flatMap((forgeId) =>
      this.gitRepos(forgeId).map((repo) => pollIntervalMs(this.forge(forgeId)!, repo)),
    );
    return intervals.length > 0 ? Math.min(...intervals) : null;
  }

  get providerIds(): string[] {
    return Object.keys(this.instance.auth?.providers ?? {});
  }

  provider(id: string): ProviderConfig | undefined {
    return this.instance.auth?.providers[id];
  }

  get hasMagicLinkProvider(): boolean {
    return this.providerIds.some((id) => {
      const provider = this.provider(id);
      return provider !== undefined && providerType(provider) === 'magic-link';
    });
  }

  get hasMailTransport(): boolean {
    return this.instance.mail !== undefined;
  }

  providerName(id: string): string {
    const provider = this.provider(id) as { display_name?: string } | undefined;
    const name = provider?.display_name?.trim();
    return name && name.length > 0 ? name : id;
  }

  get defaultProviderId(): string | undefined {
    const explicit = this.instance.auth?.default_provider;
    if (explicit) return explicit;

    return this.providerIds.length === 1 ? this.providerIds[0] : undefined;
  }

  get assets(): Required<Pick<AssetsConfig, 'driver'>> & AssetsConfig {
    return {
      driver: 'filesystem',
      path: env('SPEICHER_ASSET_PATH'),

      max_asset_bytes: 10_000_000,
      presign_over_bytes: 0,
      presign_ttl: '60s',
      ...(this.instance.assets ?? {}),
    } as Required<Pick<AssetsConfig, 'driver'>> & AssetsConfig;
  }

  get notify(): Required<Omit<NotifyConfig, never>> {
    return {
      sync_failure: ['maintainers', 'committer'],
      stale: ['admins'],
      grant_expiry: ['maintainers'],
      stale_after: '6h',
      expiry_warning: '14d',
      ...(this.instance.notify ?? {}),
    } as Required<NotifyConfig>;
  }

  get themeTemplate(): string {
    return this.instance.theme?.template ?? 'default';
  }

  /** Per-scheme CSS overrides, cached and invalidated on config change */
  themeOverridesFor(scheme: ColourScheme | null): string | null {
    const stored = this.instance.theme;
    if (this.themeSource !== stored) {
      this.themeSource = stored;
      this.themeCache.clear();
    }
    const key = scheme ?? 'system';
    if (!this.themeCache.has(key)) this.themeCache.set(key, themeOverrides(stored, scheme));
    return this.themeCache.get(key) ?? null;
  }

  get attribution(): boolean {
    return this.instance.attribution ?? true;
  }

  get brand(): string {
    return this.instance.brand?.name?.trim() || defaultBrand();
  }

  private brandImage(spec: BrandImageSpec): BrandImage | null {
    return this.loaded.brandImages.get(spec.field) ?? null;
  }

  get brandLogo(): BrandImage | null {
    return this.brandImage(BRAND_LOGO);
  }

  get brandLogoDark(): BrandImage | null {
    return this.brandImage(BRAND_LOGO_DARK);
  }

  get brandIcon(): BrandImage | null {
    return this.brandImage(BRAND_ICON);
  }

  get brandImages(): BrandImage[] {
    return BRAND_IMAGES.map((spec) => this.brandImage(spec)).filter(
      (image): image is BrandImage => image !== null,
    );
  }

  get brandShowName(): boolean {
    return this.instance.brand?.show_name ?? true;
  }

  get brandLogoUrl(): string | null {
    const logo = this.brandLogo;
    return logo ? brandImageUrl(logo) : null;
  }

  get brandLogoDarkUrl(): string | null {
    const logo = this.brandLogoDark;
    return logo ? brandImageUrl(logo) : null;
  }

  get faviconUrl(): string {
    const icon = this.brandIcon;
    return icon ? brandImageUrl(icon) : '/favicon.ico';
  }

  get faviconType(): string {
    return this.brandIcon?.mediaType ?? 'image/svg+xml';
  }

  get graph(): Required<GraphConfig> {
    const graph = this.instance.graph ?? {};
    const enabled = graph.enabled ?? true;
    return {
      enabled,
      related: enabled && (graph.related ?? true),
      previews: enabled && (graph.previews ?? true),
      terms: enabled && (graph.terms ?? true),
      search_boost: enabled && (graph.search_boost ?? true),
      related_limit: graph.related_limit ?? 8,
    };
  }

  get analytics(): Required<AnalyticsConfig> {
    const analytics = this.instance.analytics ?? {};
    const enabled = analytics.enabled ?? false;
    return {
      enabled,
      timezone: analytics.timezone ?? 'UTC',
      granularity: analytics.granularity ?? 'day',
      unique_readers: enabled && (analytics.unique_readers ?? true),
      public_beacon: enabled && (analytics.public_beacon ?? true),
      retention_days: analytics.retention_days ?? 90,
      search_retention_days: analytics.search_retention_days ?? 30,
    };
  }

  get embedding(): (Required<Omit<EmbeddingConfig, 'api_key'>> & { api_key?: string }) | null {
    const embedding = this.instance.embedding;
    if (!embedding) return null;
    return {
      send_dimensions: true,
      batch_size: 96,
      max_concurrency: 4,
      ...embedding,
    };
  }

  get syncDefaults(): Required<SyncConfig> {
    return {
      include: this.instance.defaults?.sync?.include ?? SYNC_DEFAULTS.include,
      exclude: this.instance.defaults?.sync?.exclude ?? SYNC_DEFAULTS.exclude,
    };
  }

  get indexableDefault(): boolean {
    return this.instance.defaults?.retrieval?.indexable ?? true;
  }

  get groupNames(): string[] {
    return Object.keys(this.instance.groups ?? {});
  }

  groupSources(name: string): GroupSource[] {
    return this.instance.groups?.[name] ?? [];
  }

  hasGroup(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.instance.groups ?? {}, name);
  }

  get publicRepos(): string[] {
    return this.instance.public?.repos ?? [];
  }

  allowsPublic(repo: RepoRef): boolean {
    const shown = `${slugify(repo.namespace)}/${repo.slug}`;
    return (this.instance.public?.repos ?? []).some((entry) => {
      const cut = entry.lastIndexOf('/');
      return `${slugify(entry.slice(0, cut))}/${entry.slice(cut + 1)}` === shown;
    });
  }

  /** Fuzzy group name match within 2 Levenshtein edits */
  suggestGroup(name: string): string | null {
    let best: { name: string; distance: number } | null = null;
    for (const candidate of this.groupNames) {
      const distance = editDistance(name, candidate);
      if (distance <= 2 && (best === null || distance < best.distance)) {
        best = { name: candidate, distance };
      }
    }
    return best?.name ?? null;
  }

  /**
   * Resolve identity to groups
   *
   * Matches by provider directory group id, domain, subject, or email
   * Expired sources are skipped
   */
  resolveInternalGroups(
    providerId: string,
    rawGroupIds: string[],
    identity?: { subject?: string | null; email?: string | null },
    now: Date = new Date(),
  ): string[] {
    const rawSet = new Set(rawGroupIds);
    const email = identity?.email?.toLowerCase();
    const domain = email?.split('@')[1];
    const subject = identity?.subject ?? undefined;

    const out: string[] = [];
    for (const [name, sources] of Object.entries(this.instance.groups ?? {})) {
      const matched = sources.some((source) => {
        if (source.provider !== providerId) return false;

        if (isExpired(source.until, now)) return false;
        if (source.id !== undefined) return rawSet.has(source.id);
        if (source.domain !== undefined) {
          return domain !== undefined && source.domain.toLowerCase() === domain;
        }
        if (source.subject !== undefined) {
          return subject !== undefined && source.subject === subject;
        }
        if (source.email !== undefined)
          return email !== undefined && source.email.toLowerCase() === email;
        return false;
      });
      if (matched) out.push(name);
    }
    return out.sort();
  }

  adminPrincipals(): Principal[] {
    return principalSetToPrincipals(this.instance.admins, this.defaultProviderId);
  }
}

/** Convert a PrincipalSet to sorted, deduplicated Principal strings */
export function principalSetToPrincipals(
  set:
    | { groups?: string[]; users?: { provider?: string; subject?: string; email?: string }[] }
    | undefined,
  defaultProviderId: string | undefined,
): Principal[] {
  const out: Principal[] = [];
  for (const group of set?.groups ?? []) out.push(groupPrincipal(group));
  for (const user of set?.users ?? []) {
    const provider = user.provider ?? defaultProviderId;
    if (!provider) continue;
    if (user.subject) out.push(subjectPrincipal(provider, user.subject));
    else if (user.email) out.push(emailPrincipal(provider, user.email));
  }
  return [...new Set(out)].sort();
}

/** Alias for providerType */
export function providerKind(provider: ProviderConfig) {
  return providerType(provider);
}

/** Levenshtein distance, used by suggestGroup */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const curr = [i, ...new Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[cols - 1];
}

/**
 * Fallback brand
 *
 * Hostname from SPEICHER_PUBLIC_URL, or the neutral default
 */
export function defaultBrand(): string {
  const declared = env('SPEICHER_PUBLIC_URL');
  if (declared) {
    try {
      const host = new URL(declared).hostname;
      if (host) return host;
    } catch {
      // Not a URL, so it names no host. The neutral brand below is the answer —
      // this is a fallback already, and throwing here would take a page down over
      // a value that was only ever being guessed from.
    }
  }
  return NEUTRAL_BRAND;
}
