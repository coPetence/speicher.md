import { createHash } from 'node:crypto';

import { Document } from 'yaml';

import { BlobStore, createBlobStore } from '../../../assets/blob-store';
import { GraphDirectoryDeps } from '../../../auth/directory/graph';
import { hasDirectory, probeDirectory } from '../../../auth/directory/lookup';
import { wordingFor } from '../../../common/config-problems';
import { ConfigError } from '../../../common/errors';
import { rootLogger } from '../../../common/logger';
import { ConfigService } from '../../../config/config.service';
import { interpolateEnv } from '../../../config/env-interpolation';
import { loadInstanceConfig } from '../../../config/parser';
import { AssetsConfig } from '../../../config/types';
import {
  EmbeddingClient,
  EmbeddingError,
  fetchWithin,
  PROBE_TIMEOUT_MS,
} from '../../../embed/client';
import {
  KeyScanner,
  keysOfHost,
  mergeKnownHosts,
  readKnownHosts,
  sshKeyscan,
} from '../../../forge/host-keys';
import { RemoteProber, probeRemote } from '../../../forge/git/probe';
import { GithubAppLinks, githubAppLinks, lookupGithubApp } from '../../../github/app-links';
import { githubHosts } from '../../../github/hosts';
import { probeMail } from '../../../notify/mailer';
import { applyForm } from '../config-form/apply';
import type { GithubAppLinksItem, KnownHostsField, Obj } from '../config-form/config-fields';
import { FETCH_HOST_KEYS_OP, at } from '../config-form/config-fields';
import { dottedPath, loadDocument, scalarString, writeAt } from '../config-form/document';
import { memberOf } from '../config-form/members';
import { allFields, cardItems, FieldStatus } from '../config-form/model';
import { sectionOf } from '../config-form/sections';
import { ConfigSectionPayload } from './payloads';
import { refusalText, stampProblems } from './problem-stamp';

// Compare store configs without runtime-only settings
function storeIdentity(assets: AssetsConfig): string {
  const { max_asset_bytes, presign_over_bytes, presign_ttl, ...store } = assets;
  void max_asset_bytes;
  void presign_over_bytes;
  void presign_ttl;
  return JSON.stringify(Object.entries(store).sort());
}

export const NOT_IN_USE_YET = 'Not in use yet';

const APP_LINKS_TTL_MS = 10 * 60 * 1000;
const FAILED_APP_LOOKUP_TTL_MS = 60 * 1000;

/** Embedding width probe response */
export interface WidthAnswer {
  status: number;
  body: { dimensions: number; model: string } | { error: string };
}

/** Host key fetch result */
export interface HostKeysAnswer {
  path: string;
  status: FieldStatus;
  // Whether fetched keys changed the field
  changed: boolean;
}

/** Warn about host keys missing from the saved config */
export function stampUnsavedHostKeys(payload: ConfigSectionPayload, storedYaml: string): void {
  if (!payload.section) return;
  const stored = loadDocument(storedYaml);
  for (const field of allFields([payload.section])) {
    if (field.kind !== 'known-hosts' || field.fetchNote) continue;
    const trusted = readKnownHosts(scalarString(stored.getIn(dottedPath(field.path)))).keys;
    const unsaved = field.keys.some(
      (key) =>
        !trusted.some((each) => each.host === key.host && each.fingerprint === key.fingerprint),
    );
    if (!unsaved) continue;
    field.fetchNote = {
      code: 'host-keys.unsaved',
      level: 'warn',
      label: 'Keys not saved',
      detail:
        'The keys in the list below are not saved yet. Save only if their fingerprints match the published ones.',
    };
  }
}

export class SectionChecks {
  constructor(
    private readonly config: ConfigService,

    private readonly directoryDeps: GraphDirectoryDeps | null = null,

    private readonly blobs: BlobStore | null = null,

    private readonly keyscan: KeyScanner = sshKeyscan,

    private readonly remoteProber: RemoteProber = probeRemote,

    private readonly githubFetch: typeof fetch = fetch,
  ) {}

  // Cache App links by API URL and credentials
  private readonly appLinks = new Map<string, { links: GithubAppLinks | null; expires: number }>();

  /** Add cached GitHub App links using saved credentials; omit failed lookups */
  async stampGithubAppLinks(payload: ConfigSectionPayload, yaml: string): Promise<void> {
    if (!payload.section) return;
    const items = cardItems([payload.section]).filter(
      (item): item is GithubAppLinksItem =>
        item.kind === 'github-app-links' && item.lookup.length > 0,
    );
    if (items.length === 0) return;

    const root = (loadDocument(yaml).toJS() as Obj | null) ?? {};
    await Promise.all(
      items.map(async (item) => {
        const stored = at(root, item.lookup) as Obj | undefined;
        let credentials;
        try {
          credentials = interpolateEnv({
            appId: scalarString(stored?.app_id).trim(),
            privateKey: scalarString(stored?.private_key),
          });
        } catch {
          // Skip credentials with unset environment variables
          return;
        }
        if (credentials.appId === '' || credentials.privateKey.trim() === '') return;

        const links = await this.githubAppLinksOf(
          item.baseUrl,
          credentials.appId,
          credentials.privateKey,
        );
        if (links) Object.assign(item, links);
      }),
    );
  }

  // Fetch App links unless cached
  private async githubAppLinksOf(
    baseUrl: string,
    appId: string,
    privateKey: string,
  ): Promise<GithubAppLinks | null> {
    const { web, api } = githubHosts(baseUrl);
    const key = createHash('sha256').update(`${api}\n${appId}\n${privateKey}`).digest('hex');
    const cached = this.appLinks.get(key);
    if (cached && cached.expires > Date.now()) return cached.links;

    let links: GithubAppLinks | null = null;
    try {
      const app = await lookupGithubApp(api, appId, privateKey, this.githubFetch);
      links = githubAppLinks(web, app.slug, app.owner);
    } catch (err) {
      rootLogger.child('config').debug('could not look up a GitHub App', {
        app_id: appId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    this.appLinks.set(key, {
      links,
      expires: Date.now() + (links ? APP_LINKS_TTL_MS : FAILED_APP_LOOKUP_TTL_MS),
    });
    return links;
  }

  /** Offer Git remote checks; run all for check=1 or one for a matching field path */
  async stampRepositoryStatus(
    payload: ConfigSectionPayload,
    yaml: string,
    check?: string,
  ): Promise<void> {
    const member = memberOf(payload.section?.id ?? '');
    if (!payload.section || member?.section !== 'sources') return;
    const sectionId = payload.section.id;

    const forge = ((loadDocument(yaml).toJS() as { forges?: Record<string, Obj> } | null)?.forges ??
      {})[member.id];
    if (!forge || forge.type !== 'git') return;
    const repos = Array.isArray(forge.repos) ? (forge.repos as Obj[]) : [];

    const fields = allFields([payload.section]).filter(
      (field) => field.schemaPath === 'forges.<key>.repos.<index>.url',
    );
    await Promise.all(
      fields.map(async (field) => {
        const repo = repos[Number(field.path.split('.')[3])];
        // Skip repositories without a URL
        if (!repo || scalarString(repo.url).trim() === '') return;
        if (check === undefined) {
          field.checkHref = `/-/config/${sectionId}?check=${encodeURIComponent(field.path)}`;
          return;
        }
        if (check !== '1' && check !== field.path) return;
        field.status = await this.repositoryStatus(repo, scalarString(forge.known_hosts));
      }),
    );
  }

  // Probe with environment variables resolved, as during sync
  private async repositoryStatus(repo: Obj, knownHosts: string): Promise<FieldStatus> {
    let values;
    try {
      values = interpolateEnv({
        url: scalarString(repo.url).trim(),
        branch: scalarString(repo.branch).trim(),
        deployKey: scalarString(repo.deploy_key),
        token: scalarString(repo.token),
        username: scalarString(repo.username),
        knownHosts,
      });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      // Show missing variables beside the URL
      const named = err.issues.length > 0 ? err.issues : [err.summary];
      const variables = named.flatMap((p) => (p.facts?.variable ? [p.facts.variable] : []));
      return {
        code: 'remote.not-configured',
        level: 'fail',
        label: 'Not configured',
        detail: named.map((p) => wordingFor(p, 'dashboard')).join(' '),
        ...(variables.length ? { facts: { variables: variables.join(', ') } } : {}),
      };
    }
    return this.remoteProber(
      values.url,
      {
        deployKey: values.deployKey || undefined,
        knownHosts: values.knownHosts || undefined,
        token: values.token || undefined,
        username: values.username || undefined,
      },
      values.branch,
    );
  }

  /**
   * Fetch SSH host keys into doc without saving and report unsaved keys
   * Return null if op does not match a host key fetch field
   */
  async fetchHostKeys(
    doc: Document,
    sectionId: string,
    op: unknown,
    storedYaml?: string,
  ): Promise<HostKeysAnswer | null> {
    if (typeof op !== 'string' || !op.startsWith(FETCH_HOST_KEYS_OP)) return null;
    const section = sectionOf(doc, sectionId);
    const field = (section ? allFields([section]) : []).find(
      (each): each is KnownHostsField => each.kind === 'known-hosts' && each.fetchOp === op,
    );
    if (!field) return null;

    const note = (
      code: string,
      level: FieldStatus['level'],
      label: string,
      detail: string,
      facts?: FieldStatus['facts'],
    ): FieldStatus => ({ code, level, label, detail, ...(facts ? { facts } : {}) });
    if (field.servers.length === 0) {
      return {
        path: field.path,
        changed: false,
        status: note(
          'host-keys.no-servers',
          'info',
          'Nothing fetched',
          'No repository with an `ssh://` URL is configured, so there are no servers to fetch keys from.',
        ),
      };
    }

    const answers = await Promise.all(
      field.servers.map(async (server, i) => {
        try {
          return { name: field.serverNames[i], lines: await this.keyscan(server), error: '' };
        } catch (err) {
          return { name: field.serverNames[i], lines: '', error: (err as Error).message };
        }
      }),
    );
    const answered = answers.filter((answer) => answer.error === '');
    const failed = answers.filter((answer) => answer.error !== '');

    // Check whether text contains exactly the fetched keys for this host
    const holds = (text: string, answer: { name: string; lines: string }) =>
      keysOfHost(text, answer.name).join('\n') === keysOfHost(answer.lines, answer.name).join('\n');

    const value = mergeKnownHosts(
      field.value,
      answered.map((answer) => answer.name),
      answered.map((answer) => answer.lines).join('\n'),
    );
    // Avoid reordering unchanged keys
    const changed =
      answered.some((answer) => !holds(field.value, answer)) &&
      writeAt(doc, dottedPath(field.path), value);

    const errors = failed.map((answer) => answer.error).join(' ');
    if (answered.length === 0) {
      return {
        path: field.path,
        changed,
        status: note('host-keys.none-fetched', 'fail', 'No keys fetched', errors, {
          failed: failed.map((answer) => answer.name).join(', '),
        }),
      };
    }
    const saved =
      storedYaml === undefined
        ? null
        : scalarString(loadDocument(storedYaml).getIn(dottedPath(field.path)));
    const unsaved = answered.filter((answer) => saved === null || !holds(saved, answer));
    const fetched =
      unsaved.length > 0
        ? `The keys of ${unsaved.map((answer) => answer.name).join(', ')} are not saved yet. Save only if their fingerprints match the published ones.`
        : `The keys of ${answered.map((answer) => answer.name).join(', ')} are already saved.`;
    if (failed.length > 0) {
      return {
        path: field.path,
        changed,
        status: note(
          'host-keys.some-fetched',
          'fail',
          'Some keys fetched',
          `${fetched} ${errors}`,
          {
            hosts: answered.map((answer) => answer.name).join(', '),
            failed: failed.map((answer) => answer.name).join(', '),
          },
        ),
      };
    }
    return {
      path: field.path,
      changed,
      status:
        unsaved.length > 0
          ? note('host-keys.fetched', 'warn', 'Keys fetched', fetched, {
              hosts: unsaved.map((answer) => answer.name).join(', '),
            })
          : note('host-keys.unchanged', 'ok', 'Keys unchanged', fetched, {
              hosts: answered.map((answer) => answer.name).join(', '),
            }),
    };
  }

  async stampDirectoryStatus(payload: ConfigSectionPayload, asked: boolean): Promise<void> {
    const member = memberOf(payload.section?.id ?? '');
    if (!payload.section || member?.section !== 'identity') return;

    // Find this provider's directory type field
    const field = allFields([payload.section]).find(
      (each) => each.path === `auth.providers.${member.id}.directory.type`,
    );
    if (!field) return;

    if (!hasDirectory(this.config, member.id)) return;

    if (!asked) {
      field.checkHref = `/-/config/${payload.section.id}?check=1`;
      return;
    }

    const status = await probeDirectory(this.config, member.id, this.directoryDeps ?? undefined);
    if (!status) return;

    field.status = { ...status };
  }

  async stampSectionCheck(
    payload: ConfigSectionPayload,
    yaml: string,
    // Run the check only when explicitly requested
    asked: boolean,
  ): Promise<void> {
    if (!payload.section) return;

    let shown: ConfigService;
    try {
      shown = new ConfigService(loadInstanceConfig(yaml));
    } catch {
      return;
    }

    if (payload.section.id === 'storage') return this.checkStore(payload, shown, asked);
    if (payload.section.id === 'mail') return this.checkMail(payload, shown, asked);
  }

  // Create a status callback that warns when checked settings are not active
  private offer(
    payload: ConfigSectionPayload,
    inForce: boolean,
    kept: string,
  ): (status: FieldStatus) => void {
    payload.section!.checkHref = `/-/config/${payload.section!.id}?check=1`;
    return (status) => {
      const { level, detail } = status;
      payload.section!.status = {
        ...status,
        level: inForce ? level : level === 'ok' ? 'warn' : level,
        detail: inForce
          ? detail
          : `${detail ? `${detail}. ` : ''}${NOT_IN_USE_YET}: this instance keeps the ${kept} it started with until it restarts`,
        facts: { ...status.facts, inForce },
      };
    };
  }

  private async checkStore(
    payload: ConfigSectionPayload,
    shown: ConfigService,
    asked: boolean,
  ): Promise<void> {
    if (!this.blobs) return;

    const inForce = storeIdentity(shown.assets) === storeIdentity(this.config.assets);
    const note = this.offer(payload, inForce, 'store');
    if (!asked) return;

    let store;
    try {
      // Reuse the active store or create a temporary probe store
      store = inForce ? this.blobs : createBlobStore(shown.assets);
    } catch (err) {
      const notConfigured = (detail: string) =>
        note({ code: 'store.not-configured', level: 'fail', label: 'Not configured', detail });
      if (!(err instanceof ConfigError)) {
        notConfigured((err as Error).message);
        return;
      }
      // Mark field errors and summarize remaining issues
      const shown = stampProblems(payload, err.issues);
      notConfigured(refusalText(err, payload.editable ? 'dashboard' : 'yaml', shown));
      return;
    }

    try {
      const status = await store.probe();
      note(status);
      await this.stampPresigning(payload, shown, store);
    } finally {
      if (!inForce) await store.close?.();
    }
  }

  private async stampPresigning(
    payload: ConfigSectionPayload,
    shown: ConfigService,
    store: BlobStore,
  ): Promise<void> {
    const over = shown.assets.presign_over_bytes ?? 0;
    if (over <= 0) return;

    const field = allFields([payload.section!]).find(
      (each) => each.path === 'assets.presign_over_bytes',
    );
    if (!field) return;

    const signed = await store
      .presign('probe', '0'.repeat(64), { ttlSeconds: 60, filename: 'probe', mime: 'text/plain' })
      .catch(() => null);
    if (signed !== null) return;

    field.status = {
      code: 'store.presign-unavailable',
      facts: { store: store.kind },
      level: 'warn',
      label: 'Pre-signing is not available',
      detail: `A ${store.kind} store cannot presign urls, so every asset is served through this instance instead.`,
    };
  }

  private async checkMail(
    payload: ConfigSectionPayload,
    shown: ConfigService,
    asked: boolean,
  ): Promise<void> {
    const mail = shown.instance.mail;
    if (!mail?.host) return;

    const running = this.config.instance.mail;
    const note = this.offer(payload, JSON.stringify(mail) === JSON.stringify(running), 'transport');
    if (!asked) return;

    const status = await probeMail(mail);
    note(status);
  }

  /**
   * Return the model's embedding width as JSON
   * Apply unsaved form values with save semantics, without full validation
   * Send dimensions only when enabled and a valid width is entered
   */
  async probeWidth(doc: Document, body: Record<string, unknown>): Promise<WidthAnswer> {
    applyForm(doc, body, 'embedding');
    const block = ((doc.toJS() as { embedding?: Obj } | null)?.embedding ?? {}) as Obj;

    let endpoint: { base_url: string; api_key: string; model: string };
    try {
      // Resolve environment variables as at startup
      endpoint = interpolateEnv({
        base_url: scalarString(block.base_url).trim(),
        api_key: scalarString(block.api_key).trim(),
        model: scalarString(block.model).trim(),
      });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      return { status: 400, body: { error: refusalText(err, 'dashboard') } };
    }

    if (endpoint.base_url === '' || endpoint.model === '') {
      return {
        status: 400,
        body: { error: 'The endpoint and the model are both needed to ask for a width.' },
      };
    }

    const typed = Number(scalarString(block.dimensions).trim());
    const width = Number.isInteger(typed) && typed > 0 ? typed : null;
    // Default send_dimensions to true, matching ConfigService
    const sends = block.send_dimensions !== false && width !== null;

    const client = new EmbeddingClient(
      {
        ...endpoint,
        dimensions: width ?? 0,
        send_dimensions: sends,
        batch_size: 1,
        max_concurrency: 1,
      },
      { fetch: fetchWithin(PROBE_TIMEOUT_MS) },
    );
    try {
      const dimensions = await client.probeWidth();
      return { status: 200, body: { dimensions, model: endpoint.model } };
    } catch (err) {
      if (!(err instanceof EmbeddingError)) throw err;
      return { status: 502, body: { error: `The endpoint did not answer: ${err.message}` } };
    }
  }
}
