import { Document, isSeq } from 'yaml';

import { carryProviderRows } from '../../../auth/provider-rename';
import { ResolvedCaller } from '../../../authz/caller';
import { wordingFor } from '../../../common/config-problems';
import { ConfigError, ConfigReadOnlyError } from '../../../common/errors';
import { rootLogger } from '../../../common/logger';
import { brandRef } from '../../../config/brand';
import { internBrandImage } from '../../../config/brand-store';
import { compareConfigs } from '../../../config/classification';
import { ConfigService } from '../../../config/config.service';
import { SaveActor, saveInstanceConfig, validateForSave } from '../../../config/loader';
import { ConfigWatcher } from '../../../config/watcher';
import { applyForm } from '../config-form/apply';
import { addTarget, reshaped, shapeControls } from '../config-form/collections';
import type { KnownHostsField } from '../config-form/config-fields';
import { FETCH_HOST_KEYS_OP } from '../config-form/config-fields';
import { dottedPath, loadDocument, serialise } from '../config-form/document';
import { memberExists, renameMember, seedMemberInto } from '../config-form/member-edits';
import { canCreateMember, isMemberId, memberOf, memberSectionId } from '../config-form/members';
import { allFields } from '../config-form/model';
import { sectionOf } from '../config-form/sections';
import { Uploads, fillUploads } from '../config-form/upload';
import { groupsOf, stampGroupUsage, stampUsage } from '../member-usage';
import { stampBrandImages } from './brand-stamp';
import { SectionChecks, stampUnsavedHostKeys } from './checks';
import { ConfigPageService, carryUnsavedSecrets } from './config-page.service';
import { stampEntryOrigins } from './origins';
import { ConfigSectionPayload } from './payloads';
import { stampPickListOptions } from './pick-list-stamp';
import { fieldPathOf, stampProblems } from './problem-stamp';
import { groupItemCount, refusedRows, rowAddOf } from './row-add';

// Save result mapped to an HTTP response
export type SaveOutcome =
  | { kind: 'page'; sectionId: string; payload: ConfigSectionPayload; status?: number }
  | { kind: 'redirect'; href: string }
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'notFound' };

export interface SaveRequest {
  caller: ResolvedCaller;
  sectionId: string;
  kind?: string;
  // Return the document instead of an HTML page
  json: boolean;
  // Defer body parsing until read-only checks pass
  readBody: () => Promise<{ uploads: Uploads; body: Record<string, unknown> }>;
  amend?: (doc: Document) => boolean;
  // False saves the member as seeded and amended, without reading the page's fields from the body. A body without
  // them would read as a page whose checkboxes were all cleared
  decode?: boolean;
}

function pageOf(sectionId: string, payload: ConfigSectionPayload, status?: number): SaveOutcome {
  return { kind: 'page', sectionId, payload, status };
}

// Land on the added entry, nearest remaining entry, or fetched host keys field
function landingOf(doc: Document, op: unknown): ConfigSectionPayload['landing'] {
  if (typeof op !== 'string') return undefined;
  if (op.startsWith(FETCH_HOST_KEYS_OP)) {
    return { path: op.slice(FETCH_HOST_KEYS_OP.length), focus: false };
  }
  if (op.startsWith('add:')) {
    const target = addTarget(op).path;
    const list = doc.getIn(dottedPath(target));
    if (!isSeq(list) || list.items.length === 0) return undefined;
    return { path: `${target}.${list.items.length - 1}`, focus: true };
  }
  const removed = /^remove:(.+)\.(\d+)$/.exec(op);
  if (!removed) return undefined;
  const [, target, index] = removed;
  const list = doc.getIn(dottedPath(target));
  if (!isSeq(list)) return undefined;
  const at = Math.min(Number(index), list.items.length - 1);
  return { path: at >= 0 ? `${target}.${at}` : target, focus: false };
}

// Show save errors on the page and affected fields using dashboard wording
function refused(
  payload: ConfigSectionPayload,
  err: ConfigError | ConfigReadOnlyError,
): ConfigSectionPayload {
  if (!(err instanceof ConfigError)) return { ...payload, error: err.message };

  const [, ...shown] = stampProblems(payload, [err.summary, ...err.issues]);
  return {
    ...payload,
    error: wordingFor(err.summary, 'dashboard'),
    error_code: err.code,
    problems: err.issues.map((p) => wordingFor(p, 'dashboard')),
    problem_codes: err.issues.map((p) => p.code),
    error_path: err.summary.path ? fieldPathOf(err.summary.path) : null,
    problem_paths: err.issues.map((p) => (p.path ? fieldPathOf(p.path) : null)),
    problems_shown: shown,
  };
}

export function provenanceOf(caller: ResolvedCaller): SaveActor {
  if (caller.viaSetup) return { origin: 'setup' };
  const identity = caller.identity;
  return {
    origin: 'admin',
    appliedBy: identity ? (identity.email ?? `${identity.provider}:${identity.subject}`) : null,
  };
}

// Shared save logic for section and provider routes
export class ConfigSaveService {
  constructor(
    private readonly config: ConfigService,
    private readonly page: ConfigPageService,
    private readonly checks: SectionChecks,
    private readonly watcher: ConfigWatcher,
  ) {}

  // Rename and save with full document validation
  private async rename(
    caller: ResolvedCaller,
    json: boolean,
    sectionId: string,
    payload: ConfigSectionPayload,
    edited: string,
    to: string,
  ): Promise<SaveOutcome> {
    const from = memberOf(sectionId);
    if (!from) return { kind: 'notFound' };
    const noun = payload.section?.noun ?? 'entry';

    const refuse = (message: string) => pageOf(sectionId, { ...payload, error: message }, 400);

    if (!isMemberId(from.section, to)) {
      return refuse(`"${to}" is not a name this key may take: lower case, digits and hyphens.`);
    }

    // Rename a copy so refusals preserve edits under the old name
    const renamed = loadDocument(edited);
    if (!renameMember(renamed, from.section, from.id, to)) {
      return refuse(`There is already a ${noun} called "${to}".`);
    }

    try {
      const saved = await saveInstanceConfig(
        caller.tenantId,
        serialise(renamed),
        provenanceOf(caller),
      );

      // Move sessions and OAuth grants to the new provider name
      if (from.section === 'identity') {
        const log = rootLogger.child('config');
        try {
          const carried = await carryProviderRows(caller.tenantId, from.id, to);
          if (carried.total > 0) {
            log.info('carried credentials to a renamed provider', {
              from: from.id,
              to,
              ...carried.moved,
            });
          }
        } catch (err) {
          log.error('a renamed provider left its credentials behind', {
            from: from.id,
            to,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const refresh = await this.watcher.refresh();

      const moved = memberSectionId(from.section, to);
      if (json) {
        const state = await this.page.state(caller);
        const after = await this.page.sectionPayload(state, moved);
        after.saved = { version: saved.version, applied_at: saved.applied_at };
        after.waiting_on = refresh.waiting;
        return pageOf(moved, after);
      }

      return { kind: 'redirect', href: `/-/config/${moved}?saved=${saved.version}` };
    } catch (err) {
      if (err instanceof ConfigReadOnlyError || err instanceof ConfigError) {
        return pageOf(sectionId, refused(payload, err), 400);
      }
      throw err;
    }
  }

  async save({
    caller,
    sectionId,
    kind,
    json,
    readBody,
    amend,
    decode = true,
  }: SaveRequest): Promise<SaveOutcome> {
    const state = await this.page.state(caller);
    const payload = await this.page.sectionPayload(state, sectionId);
    // Protect submitted work with the unload guard, independently of pending changes
    payload.holds_work = true;

    // Keep dependency lists populated when re-rendering
    await stampUsage(caller.tenantId, sectionId, payload);

    // Reject read-only mode before parsing or validation can obscure the reason
    if (!payload.editable) {
      const refusal = new ConfigReadOnlyError(this.config.sourcePath);
      return pageOf(sectionId, { ...payload, error: refusal.message }, 409);
    }

    // Parse multipart data here; @Body() would run before multer populates it
    const { uploads, body } = await readBody();

    let doc;
    try {
      doc = loadDocument(state.storedYaml);
    } catch (err) {
      // Invalid stored YAML cannot be edited through the form
      return pageOf(sectionId, { ...payload, error: (err as Error).message }, 409);
    }

    // Probe width without creating members or validating unrelated settings
    if (body.intent === 'width' && sectionId === 'embedding') {
      return { kind: 'json', ...(await this.checks.probeWidth(doc, body)) };
    }

    // Seed new members before decoding so the form has a matching section
    const member = memberOf(sectionId);
    const created = member !== null && canCreateMember(member, kind) && !memberExists(doc, member);
    if (created && member) {
      seedMemberInto(doc, member, kind ?? '');
    }

    // New identity providers need a kind hint until their issuer is set
    const hint =
      created && member?.section === 'identity' && kind !== undefined
        ? { provider: member.id, kind }
        : undefined;
    // Preserve the selected kind when a creation form is returned unsaved
    if (payload.creating && created && kind !== undefined) payload.creating_kind = kind;

    // Accept uploads only for fields offered by the loaded, seeded form
    const offered = sectionOf(doc, sectionId, hint);
    const refusal =
      uploads.refusal ??
      (await fillUploads(offered ? allFields([offered]) : [], uploads, body, async (image) => {
        await internBrandImage(caller.tenantId, image);
        return brandRef(image);
      }));

    const rowAdd = rowAddOf(body.op);
    const before = rowAdd ? groupItemCount(doc, rowAdd.group) : 0;

    // Decode only this section to avoid clearing checkboxes in other sections
    const { structural, changed: edited_ } = decode
      ? applyForm(doc, body, sectionId, hint)
      : { structural: false, changed: false };

    const rowsRefused = rowAdd && structural ? refusedRows(doc, body, rowAdd, before) : null;
    const amended = amend?.(doc) ?? false;
    // Fetch host keys into the edited document without saving
    const hostKeys = await this.checks.fetchHostKeys(doc, sectionId, body.op, state.storedYaml);

    const changed = edited_ || amended || created || hostKeys?.changed === true;
    const edited =
      changed && serialise(doc) !== serialise(loadDocument(state.storedYaml))
        ? serialise(doc)
        : state.storedYaml;
    // Rebuild from edits so refused saves preserve submitted work
    payload.section = sectionOf(doc, sectionId, hint) ?? null;

    await stampBrandImages(caller.tenantId, payload);
    await stampPickListOptions(caller.tenantId, payload);
    await stampEntryOrigins(caller.tenantId, payload);
    await stampGroupUsage(caller.tenantId, payload, groupsOf(doc));
    await this.checks.stampDirectoryStatus(payload, false);
    await this.checks.stampRepositoryStatus(payload, edited);
    await this.checks.stampGithubAppLinks(payload, edited);
    await this.checks.stampSectionCheck(payload, edited, false);
    const fetchedInto =
      hostKeys && payload.section
        ? allFields([payload.section]).find(
            (field): field is KnownHostsField =>
              field.kind === 'known-hosts' && field.path === hostKeys.path,
          )
        : undefined;
    if (hostKeys && fetchedInto) fetchedInto.fetchNote = hostKeys.status;
    stampUnsavedHostKeys(payload, state.storedYaml);
    carryUnsavedSecrets(payload, doc, state.storedYaml);

    payload.pending = edited !== state.storedYaml || payload.creating;
    payload.shape = payload.section ? shapeControls(doc, payload.section) : [];

    if (refusal) {
      return pageOf(sectionId, { ...payload, error: refusal }, 400);
    }

    // Renaming saves the member at a new URL
    const renameTo = body['rename'];
    if (
      payload.section?.renameOp &&
      body.op === payload.section.renameOp &&
      typeof renameTo === 'string' &&
      renameTo.trim() !== ''
    ) {
      return this.rename(caller, json, sectionId, payload, edited, renameTo.trim());
    }

    // List edits and host-key fetches re-render without validating or saving
    if (rowsRefused) {
      return pageOf(sectionId, { ...payload, row_add: rowsRefused }, 400);
    }
    if (structural || hostKeys) {
      payload.landing = landingOf(doc, body.op);
      return pageOf(sectionId, payload);
    }

    // Show newly required controls before validating or saving
    if (payload.section && reshaped(payload.section, body)) {
      return pageOf(sectionId, payload);
    }

    const by = provenanceOf(caller);
    let proposed;
    try {
      // Use the save validator, including administrator lockout checks
      proposed = validateForSave(edited, {
        // Match the save's setup exemption from administrator requirements
        requireAdministrator: by.origin !== 'setup',
      });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      return pageOf(sectionId, refused(payload, err), 400);
    }

    payload.verdict = compareConfigs(this.config.loadedConfig, proposed);

    if (body.intent !== 'apply') return pageOf(sectionId, payload);

    if (created && member?.section === 'groups' && groupItemCount(doc, member.id) === 0) {
      return pageOf(
        sectionId,
        {
          ...payload,
          verdict: null,
          error: 'A group needs at least one member. Add a member before you save the group.',
        },
        400,
      );
    }

    // Skip saving unchanged YAML
    if (edited === state.storedYaml) {
      if (json) {
        payload.pending = false;
        payload.holds_work = false;
        return pageOf(sectionId, payload);
      }
      return { kind: 'redirect', href: `/-/config/${sectionId}` };
    }

    try {
      const saved = await saveInstanceConfig(caller.tenantId, edited, by);

      // Refresh locally now; other replicas update on their next poll
      const refresh = await this.watcher.refresh();

      if (json) {
        payload.saved = { version: saved.version, applied_at: saved.applied_at };
        payload.editing_version = saved.version;
        payload.running_version = this.config.configVersion;
        payload.waiting_on = refresh.waiting;
        // Submitted work is now stored
        payload.pending = false;
        payload.holds_work = false;
        return pageOf(sectionId, payload);
      }

      // Redirect after saving to prevent reloads from creating duplicate versions
      return { kind: 'redirect', href: `/-/config/${sectionId}?saved=${saved.version}` };
    } catch (err) {
      // Show save-time refusals on the form
      if (err instanceof ConfigReadOnlyError || err instanceof ConfigError) {
        return pageOf(sectionId, refused(payload, err), 409);
      }
      throw err;
    }
  }
}
