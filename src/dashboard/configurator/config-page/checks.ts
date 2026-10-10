import { Document } from 'yaml';

import { BlobStore, createBlobStore } from '../../../assets/blob-store';
import { GraphDirectoryDeps } from '../../../auth/directory/graph';
import { hasDirectory, probeDirectory } from '../../../auth/directory/lookup';
import { ConfigError } from '../../../common/errors';
import { ConfigService } from '../../../config/config.service';
import { interpolateEnv } from '../../../config/env-interpolation';
import {
  EmbeddingClient,
  EmbeddingError,
  fetchWithin,
  PROBE_TIMEOUT_MS,
} from '../../../embed/client';
import { loadInstanceConfig } from '../../../config/parser';
import { AssetsConfig } from '../../../config/types';
import { probeMail } from '../../../notify/mailer';
import { applyForm } from '../config-form/apply';
import { scalarString } from '../config-form/document';
import type { Obj } from '../config-form/config-fields';
import { memberOf } from '../config-form/members';
import { FieldStatus, allFields } from '../config-form/model';
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

export class SectionChecks {
  constructor(
    private readonly config: ConfigService,

    private readonly directoryDeps: GraphDirectoryDeps | null = null,

    private readonly blobs: BlobStore | null = null,
  ) {}

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
      icon: status.level === 'ok' ? 'check' : 'circle-alert',
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
        icon: level === 'ok' && inForce ? 'check' : 'circle-alert',
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
    } finally {
      if (!inForce) await store.close?.();
    }
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
