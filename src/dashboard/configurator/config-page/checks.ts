import { Document } from 'yaml';

import { BlobStore, createBlobStore } from '../../../assets/blob-store';
import { GraphDirectoryDeps } from '../../../auth/directory/graph';
import { hasDirectory, probeDirectory } from '../../../auth/directory/lookup';
import { ConfigError } from '../../../common/errors';
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
import { probeMail } from '../../../notify/mailer';
import { applyForm } from '../config-form/apply';
import type { KnownHostsField, Obj } from '../config-form/config-fields';
import { FETCH_HOST_KEYS_OP } from '../config-form/config-fields';
import { dottedPath, loadDocument, scalarString, writeAt } from '../config-form/document';
import { memberOf } from '../config-form/members';
import { allFields, FieldStatus } from '../config-form/model';
import { sectionOf } from '../config-form/sections';
import { ConfigSectionPayload } from './payloads';

// Stable key for comparing store configs, excluding runtime-only fields
function storeIdentity(assets: AssetsConfig): string {
  const { max_asset_bytes, presign_over_bytes, presign_ttl, ...store } = assets;
  void max_asset_bytes;
  void presign_over_bytes;
  void presign_ttl;
  return JSON.stringify(Object.entries(store).sort());
}

export const NOT_IN_USE_YET = 'Not in use yet';

/**
 * The live checks a settings page offers: whether the store, the mail relay or a
 * provider's directory answers.
 *
 * Apart from the page service because these are the only parts of a settings page
 * that make a request to somebody else's endpoint, and the only ones holding the
 * dependencies a spec swaps for a fake one.
 */
/** What the width probe answers: a status and the JSON the island reads. */
export interface WidthAnswer {
  status: number;
  body: { dimensions: number; model: string } | { error: string };
}

/** Response of fetching host keys. */
export interface HostKeysAnswer {
  path: string;
  status: FieldStatus;
  // True when the fetched keys changed the field's value
  changed: boolean;
}

/**
 * Puts a note on every known hosts field of the page that lists a key the stored
 * document does not trust yet.
 *
 * @param payload the page that is sent back
 * @param storedYaml the stored document the keys are compared against
 */
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
  ) {}

  /**
   * stampRepositoryStatus offers a connection check under the remote URL of each repository of a plain git remote.
   * @param payload the page that is sent back
   * @param yaml the configuration the check reads
   * @param check the `check` parameter of the request, or undefined if the user did not ask
   */
  async stampRepositoryStatus(
    payload: ConfigSectionPayload,
    yaml: string,
    check?: string,
  ): Promise<void> {
    const member = memberOf(payload.section?.id ?? '');
    if (!payload.section || member?.section !== 'sources' || member.entry) return;
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
        // A repository without a URL has nothing to check yet
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

  // Probes one repository with its values as a sync reads them, `${VAR}` resolved
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
      const problems = err instanceof ConfigError ? err.problems : [(err as Error).message];
      return { level: 'fail', label: 'Not configured', detail: problems.join(' ') };
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
   * fetchHostKeys fetches the host keys of the SSH servers of a content source.
   * It writes the keys into the known hosts field of `doc`. It does not save them.
   * If `op` is not Fetch host keys, fetchHostKeys returns null.
   * The returned note says which keys are not saved yet.
   *
   * @param doc the submitted form
   * @param sectionId the content source page
   * @param op the button the user pressed
   * @param storedYaml the saved configuration
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

    const note = (level: FieldStatus['level'], label: string, detail: string) => ({
      level,
      label,
      detail,
    });
    if (field.servers.length === 0) {
      return {
        path: field.path,
        changed: false,
        status: note(
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

    // Whether `text` holds exactly the keys the server of `answer` answered with
    const holds = (text: string, answer: { name: string; lines: string }) =>
      keysOfHost(text, answer.name).join('\n') === keysOfHost(answer.lines, answer.name).join('\n');

    const value = mergeKnownHosts(
      field.value,
      answered.map((answer) => answer.name),
      answered.map((answer) => answer.lines).join('\n'),
    );
    // Rewriting lines that already hold the answered keys would only reorder them
    const changed =
      answered.some((answer) => !holds(field.value, answer)) &&
      writeAt(doc, dottedPath(field.path), value);

    const errors = failed.map((answer) => answer.error).join(' ');
    if (answered.length === 0) {
      return { path: field.path, changed, status: note('fail', 'No keys fetched', errors) };
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
        status: note('fail', 'Some keys fetched', `${fetched} ${errors}`),
      };
    }
    return {
      path: field.path,
      changed,
      status:
        unsaved.length > 0
          ? note('warn', 'Keys fetched', fetched)
          : note('ok', 'Keys unchanged', fetched),
    };
  }

  async stampDirectoryStatus(payload: ConfigSectionPayload, asked: boolean): Promise<void> {
    const member = memberOf(payload.section?.id ?? '');
    if (!payload.section || member?.section !== 'identity' || member.entry) return;

    // Only identity sections without an entry get directory probes
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

    field.status = {
      level: status.level,
      label: status.label,
      detail: status.detail,
    };
  }

  async stampSectionCheck(
    payload: ConfigSectionPayload,
    yaml: string,
    // True when the user explicitly triggered the check, false for passive label only
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

  // Builds the callback that stamps status on the section, adjusting severity when
  // the checked config is not the one currently in force
  private offer(
    payload: ConfigSectionPayload,
    inForce: boolean,
    kept: string,
  ): (level: FieldStatus['level'], label: string, detail: string) => void {
    payload.section!.checkHref = `/-/config/${payload.section!.id}?check=1`;
    return (level, label, detail) => {
      payload.section!.status = {
        level: inForce ? level : level === 'ok' ? 'warn' : level,
        label,
        detail: inForce
          ? detail
          : `${detail ? `${detail}. ` : ''}${NOT_IN_USE_YET}: this instance keeps the ${kept} it started with until it restarts`,
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
      // Reuse existing blob store handle if config matches, else instantiate a
      // throwaway one for the probe
      store = inForce ? this.blobs : createBlobStore(shown.assets);
    } catch (err) {
      // ConfigError carries multiple problems from validation
      const problems = err instanceof ConfigError ? err.problems : [];
      note('fail', 'Not configured', [(err as Error).message, ...problems].join(' — '));
      return;
    }

    try {
      const status = await store.probe();
      note(status.level, status.label, status.detail);
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
    note(status.level, status.label, status.detail);
  }

  /**
   * The width the model named in the form returns, for the island to write into
   * Dimensions.
   *
   * It reads the form the way a save reads it — `applyForm` on the stored document,
   * so a blank secret keeps what is stored and a switch means what it means on the
   * page — rather than the running configuration, which the operator has not saved.
   * It does not validate the document. An operator is mid-edit, and a check that
   * refused every half-finished form would answer nothing while they typed.
   *
   * The parameter goes out only when a save would send it: `send_dimensions` on and a
   * width typed. With no width typed the model answers at its own width, which is the
   * number that goes in the box. A Matryoshka model with the parameter on answers at
   * the typed width, so the box is never filled with one the boot probe would refuse.
   *
   * JSON only. A page without a script never sends this intent, so there is no page
   * for it to answer with.
   */
  async probeWidth(doc: Document, body: Record<string, unknown>): Promise<WidthAnswer> {
    applyForm(doc, body, 'embedding');
    const block = ((doc.toJS() as { embedding?: Obj } | null)?.embedding ?? {}) as Obj;

    let endpoint: { base_url: string; api_key: string; model: string };
    try {
      // `${VAR}` is resolved here as it is at load, so the probe sends what a boot would
      endpoint = interpolateEnv({
        base_url: scalarString(block.base_url).trim(),
        api_key: scalarString(block.api_key).trim(),
        model: scalarString(block.model).trim(),
      });
    } catch (err) {
      const problems = err instanceof ConfigError ? err.problems : [];
      return { status: 400, body: { error: [(err as Error).message, ...problems].join(' — ') } };
    }

    if (endpoint.base_url === '' || endpoint.model === '') {
      return {
        status: 400,
        body: { error: 'The endpoint and the model are both needed to ask for a width.' },
      };
    }

    const typed = Number(scalarString(block.dimensions).trim());
    const width = Number.isInteger(typed) && typed > 0 ? typed : null;
    // `send_dimensions` defaults on, as `ConfigService.embedding` defaults it
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
