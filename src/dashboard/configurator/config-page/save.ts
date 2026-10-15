import { Document, isSeq } from 'yaml';

import { carryProviderRows } from '../../../auth/provider-rename';
import { ResolvedCaller } from '../../../authz/caller';
import { ConfigError, ConfigReadOnlyError } from '../../../common/errors';
import { rootLogger } from '../../../common/logger';
import { brandRef } from '../../../config/brand';
import { internBrandImage } from '../../../config/brand-store';
import { stampBrandImages } from './brand-stamp';
import { compareConfigs } from '../../../config/classification';
import { ConfigService } from '../../../config/config.service';
import { SaveActor, saveInstanceConfig, validateForSave } from '../../../config/loader';
import { ConfigWatcher } from '../../../config/watcher';
import { nextSetupPage, setupStateOf } from '../../setup/steps';
import { applyForm } from '../config-form/apply';
import { reshaped, shapeControls } from '../config-form/collections';
import type { KnownHostsField } from '../config-form/config-fields';
import { FETCH_HOST_KEYS_OP } from '../config-form/config-fields';
import { dottedPath, loadDocument, serialise } from '../config-form/document';
import { memberExists, renameMember, seedMemberInto } from '../config-form/member-edits';
import { canCreateMember, isMemberId, memberOf, memberSectionId } from '../config-form/members';
import { allFields } from '../config-form/model';
import { sectionOf } from '../config-form/sections';
import { Uploads, fillUploads } from '../config-form/upload';
import { stampUsage } from '../member-usage';
import { SectionChecks, stampUnsavedHostKeys } from './checks';
import { ConfigPageService, carryUnsavedSecrets } from './config-page.service';
import { stampEntryOrigins } from './origins';
import { ConfigSectionPayload } from './payloads';

/**
 * What a save asks of the HTTP layer, and nothing more.
 *
 * The save decides; the controller answers. Keeping `Request` and `Response` out
 * of this file is what lets every branch below be read as a decision rather than
 * as a sequence of writes to a socket — and the four kinds are every answer the
 * two save routes have ever given.
 */
export type SaveOutcome =
  | { kind: 'page'; sectionId: string; payload: ConfigSectionPayload; status?: number }
  | { kind: 'redirect'; href: string }
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'notFound' };

export interface SaveRequest {
  caller: ResolvedCaller;
  sectionId: string;
  kind?: string;
  // Whether the caller asked for the document rather than a page
  json: boolean;
  /**
   * The body, parsed when the save is ready for it. A callback rather than a value,
   * because a `file`-mode refusal is given before anything is decoded — see the
   * check on `payload.editable` — and the multipart body is not read at all then.
   */
  readBody: () => Promise<{ uploads: Uploads; body: Record<string, unknown> }>;
}

function pageOf(sectionId: string, payload: ConfigSectionPayload, status?: number): SaveOutcome {
  return { kind: 'page', sectionId, payload, status };
}

/**
 * Where the page lands after an op added an entry to a list, removed one from it or
 * fetched host keys, or null for any other op. After `add:` it is the new entry, e.g.
 * `forges.git.repos.2`, and its first field is focused. After `remove:` it is the entry
 * that took the removed one's place, else the one before it, else the list itself,
 * whose Add button is there. After Fetch host keys it is the known hosts field, whose
 * card the page opens at
 *
 * @param doc the document the op was applied to
 * @param op the submitted op
 */
function landingOf(doc: Document, op: unknown): ConfigSectionPayload['landing'] {
  if (typeof op !== 'string') return undefined;
  if (op.startsWith(FETCH_HOST_KEYS_OP)) {
    return { path: op.slice(FETCH_HOST_KEYS_OP.length), focus: false };
  }
  if (op.startsWith('add:')) {
    const target = op.slice('add:'.length);
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

/**
 * The page handed back with the loader's reason on it: the first line as the
 * headline, and every problem beneath it. One spelling, so the five places a save
 * can be refused cannot come to say it differently.
 */
function refused(
  payload: ConfigSectionPayload,
  err: ConfigError | ConfigReadOnlyError,
): ConfigSectionPayload {
  return err instanceof ConfigError
    ? { ...payload, error: err.message.split('\n')[0], problems: err.problems }
    : { ...payload, error: err.message };
}

export function provenanceOf(caller: ResolvedCaller): SaveActor {
  if (caller.viaSetup) return { origin: 'setup' };
  const identity = caller.identity;
  return {
    origin: 'admin',
    appliedBy: identity ? (identity.email ?? `${identity.provider}:${identity.subject}`) : null,
  };
}

/**
 * A save, whichever page it came from.
 *
 * The POST routes differ in what they let a caller name — one of the nine,
 * or a provider — and in nothing else. Everything below is about the document.
 */
export class ConfigSaveService {
  constructor(
    private readonly config: ConfigService,
    private readonly page: ConfigPageService,
    private readonly checks: SectionChecks,
    private readonly watcher: ConfigWatcher,
  ) {}

  /**
   * Apply a rename and save it, or answer why it was refused.
   *
   * Separate from the save below because the two differ in what they write and in
   * where they land, and sharing the tail of one with the other would mean a
   * branch inside every step of it. What they share is the part that matters:
   * both hand the *whole* document to `saveInstanceConfig`, which is the loader,
   * so a rename is checked exactly as hard as a value.
   */
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

    // On a copy, so a refusal hands back the operator's own edits with the old
    // name still on them rather than a page for a member that was never stored.
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

      /*
        And the rows minted under the old spelling, which the document cannot
        reach. A provider's key is what every principal is built from, so a
        session, an API key or an OAuth grant left naming the old one resolves to
        nobody — including the administrator who just pressed the button, whose
        repair would be to clear a cookie and sign in again. The two credentials
        that are not a cookie have no such repair.

        After the save, because the save is the step that can be refused; a
        failure here leaves the rows behind and is logged at error, which is the
        state this instance was in before any of it was carried.
      */
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

      // The member is at a different URL now, and this is the only place under
      // `/-/config` where a save moves the page it was made on.
      return { kind: 'redirect', href: `/-/config/${moved}?saved=${saved.version}` };
    } catch (err) {
      if (err instanceof ConfigReadOnlyError || err instanceof ConfigError) {
        return pageOf(sectionId, refused(payload, err), 400);
      }
      throw err;
    }
  }

  async save({ caller, sectionId, kind, json, readBody }: SaveRequest): Promise<SaveOutcome> {
    const state = await this.page.state(caller);
    const payload = await this.page.sectionPayload(state, sectionId);
    // Every answer below is a submission rendered back, so whatever is in the boxes
    // was typed in a browser and is stored nowhere. That is what the unload guard
    // protects, and it is not the question `pending` answers — see `holds_work`.
    payload.holds_work = true;

    // The same list the GET carries: every answer below re-renders this page, and a
    // modal that came back empty would read as "nothing depends on this name".
    await stampUsage(caller.tenantId, sectionId, payload);

    // Refused before anything is decoded, and deliberately so. Running the whole
    // form through the loader first would answer a `file`-mode operator with
    // "your configuration is invalid" when the true answer is that this instance
    // does not accept writes at all. `saveInstanceConfig` refuses again on its own
    // account; this is the one that gives the right reason.
    if (!payload.editable) {
      const refusal = new ConfigReadOnlyError(this.config.sourcePath);
      return pageOf(sectionId, { ...payload, error: refusal.message }, 409);
    }

    // The form posts `multipart/form-data`, because one of its controls is a file
    // picker and a picker without JavaScript has no other encoding — so the body is
    // parsed by multer when this asks for it, not by the urlencoded parser, and the
    // routes carry no `@Body()`: the decorator resolves before the handler runs and
    // would hand back the empty object multer is about to replace.
    const { uploads, body } = await readBody();

    let doc;
    try {
      doc = loadDocument(state.storedYaml);
    } catch (err) {
      // The stored document does not parse, so there is no form to edit it with.
      // Only reachable on an instance whose newest version is broken, which the
      // page already says outright.
      return pageOf(sectionId, { ...payload, error: (err as Error).message }, 409);
    }

    // The width the model named in this form returns, asked for when the model is
    // entered. Answered before anything else is decoded, because a width is not a
    // save: nothing here may create a member or refuse the page over a problem the
    // rest of the document has. See `SectionChecks.probeWidth`.
    if (body.intent === 'width' && sectionId === 'embedding') {
      return { kind: 'json', ...(await this.checks.probeWidth(doc, body)) };
    }

    // A page for a member that does not exist yet brings it into existence, before
    // a single value is decoded — otherwise there is no section to decode against
    // and the save would write nothing behind a 200. The id is the route's, the
    // kind is checked against the closed list, and the seed is the one
    // `draftPayload` rendered from, so what is created is what was on screen.
    const member = memberOf(sectionId);
    const created = member !== null && canCreateMember(member, kind) && !memberExists(doc, member);
    if (created && member) {
      seedMemberInto(doc, member, kind ?? '');
    }

    // A provider being created has no issuer yet, so nothing in the document says
    // which kind of OIDC provider it is — the kind the page was opened with is what
    // decides which controls were rendered, and decoding has to build the same form
    // that was submitted or it reads the tenant box as an issuer. See `KindHint`.
    // A content source's kind is written by its seed, so its document answers and
    // it needs no hint; a group has one shape, so there is nothing to remember.
    const hint =
      created && member?.section === 'identity' && kind !== undefined
        ? { provider: member.id, kind }
        : undefined;
    // Kept on the page, so a refused save comes back still knowing what it is
    // making — every collection whose members have shapes, not only the one that
    // also needs a hint. `creating` is asked of the stored document, so it stays
    // true until a save succeeds.
    if (payload.creating && created && kind !== undefined) payload.creating_kind = kind;

    /*
      What was uploaded, entering the submission under the paths the form offered.

      Here rather than beside the parse, because the model it is checked against
      does not exist until the document has been loaded and a member being created
      has been seeded — and the first save of a new GitHub source is exactly the
      request carrying its `.pem`. The bytes then travel as a value and are decoded
      by the same walk as every box, so a file cannot reach a path the form did not
      just render, which is the property that matters on the endpoint that writes
      `admins`.
    */
    const offered = sectionOf(doc, sectionId, hint);
    const refusal =
      uploads.refusal ??
      (await fillUploads(offered ? allFields([offered]) : [], uploads, body, async (image) => {
        await internBrandImage(caller.tenantId, image);
        return brandRef(image);
      }));

    // Only this section's fields, ops and collections. An absent control is a
    // *value* for a checkbox, so decoding the whole model against one section's
    // submission would turn off every switch on the other seven — see `applyForm`.
    const { structural, changed: edited_ } = applyForm(doc, body, sectionId, hint);
    // The Fetch host keys button: a round trip like Add, which writes the fetched keys
    // into the edited document and stores nothing. See `SectionChecks.fetchHostKeys`
    const hostKeys = await this.checks.fetchHostKeys(doc, sectionId, body.op, state.storedYaml);

    /*
      The id a member being created is stored under.

      The add modal used to ask it beside the kind, and it left with the modal: the
      kinds are cards now, a card answers one question, and the id arrived as
      `freeMemberId`'s suggestion with nowhere to change it. The box is on the
      creating form instead — the pencil is not an option there, because a rename is
      a save that moves a key and there is no key until this request finishes.

      Applied by *moving the finished member*, not by decoding into a different path.
      Every control on that page submits under a path containing the id the route
      carries, so the id cannot be known before the form is decoded: the save seeds
      at the route's id, fills it in, and moves the key afterwards. `renameMember`
      is the same function the pencil uses, so a provider created as `entra` and
      typed as `corp` lands with `auth.default_provider` already pointing at it.

      A name that is taken is refused here rather than by `renameMapKey` returning
      false at save time, because the operator is owed the reason and their own
      work back — and because the two failures are different: one is a typo, the
      other would silently merge two providers.
    */
    const wantedId =
      created && member && offered?.renameOp
        ? String(body[`newname:${sectionId}`] ?? '').trim()
        : '';
    const renamesTo = member && wantedId !== '' && wantedId !== member.id ? wantedId : null;
    const idTaken =
      renamesTo !== null && member !== null && memberExists(doc, { ...member, id: renamesTo });
    const changed = edited_ || created || hostKeys?.changed === true;
    // Only re-serialise when a value actually moved. Rendering an untouched
    // document back out would normalise its formatting, so opening the form and
    // pressing Save would append a version that differs by whitespace alone.
    const edited = changed ? serialise(doc) : state.storedYaml;
    // Everything from here describes the *edited* document, so a refused save hands
    // back the operator's own work rather than the version on disk.
    payload.section = sectionOf(doc, sectionId, hint) ?? null;

    await stampBrandImages(caller.tenantId, payload);
    await stampEntryOrigins(caller.tenantId, payload);
    await this.checks.stampDirectoryStatus(payload, false);
    await this.checks.stampRepositoryStatus(payload, edited);
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

    if (refusal || idTaken) {
      const error = idTaken
        ? `There is already a \`${renamesTo}\` here. Every short id in this ` +
          'collection is distinct, because it is the key the document stores and ' +
          'the name a grant is written against.'
        : refusal;
      return pageOf(sectionId, { ...payload, error }, 400);
    }

    /*
      Renaming the member this page is about.

      The one operation here that is a *save* rather than a round trip, and it has
      to be: the id is the key, so a renamed provider lives at a URL that nothing
      has stored yet — a round trip would leave the operator on a page for a
      member the next request cannot find. Saving makes the new name real, and the
      303 lands them on it.

      It is applied to a copy, so a refusal costs nothing: the document that comes
      back is the one *without* the rename, carrying every edit the operator had
      typed, and the loader's message says why. Renaming onto a name that is taken
      would silently merge two of them, so `renameMember` refuses it and the
      page says so rather than guessing which one was meant.

      What it cannot reach is a grant written in a repository — `speicher.yaml`
      can name a provider by id, and those documents are not this instance's to
      edit. Such a grant becomes an `unknown-provider` rejection at the next sync:
      dropped, and reported to the author. The page says so before the button.
    */
    const renameTo = (body[`newname:${sectionId}`] ?? body['rename'] ?? '') as string;
    if (
      payload.section?.renameOp &&
      body.op === payload.section.renameOp &&
      typeof renameTo === 'string' &&
      renameTo.trim() !== ''
    ) {
      return this.rename(caller, json, sectionId, payload, edited, renameTo.trim());
    }

    // Adding or removing an entry is a round trip, not a save: the operator has
    // asked for somewhere to type, and an empty provider does not validate yet.
    if (structural || hostKeys) {
      payload.landing = landingOf(doc, body.op);
      return pageOf(sectionId, payload);
    }

    /*
      And so is moving a control that decides which controls exist.

      Picking a different asset driver asks for boxes that are not on the page —
      an Azure account, an S3 bucket — and the schema requires them, so validating
      here would refuse the save for a key the operator has no way to fill in. The
      page comes back asking its new questions instead, with everything else they
      had typed still in it, and the next save is the one that stores it.

      Read off the section rebuilt from the *edited* document and compared against
      what the page said it was showing, because this round trip stores nothing —
      see `Field.reshapes`.
    */
    if (payload.section && reshaped(payload.section, body)) {
      return pageOf(sectionId, payload);
    }

    const by = provenanceOf(caller);
    let proposed;
    try {
      // The real loader, the real code path — literally the call `saveInstanceConfig`
      // makes. Anything the process would refuse to boot on is refused here, with
      // the loader's own message and problem list, and so is anything the *save*
      // refuses that a boot would not: a document leaving nobody able to administer
      // the instance is legitimate to boot into and never legitimate to write, and
      // the check that tells the operator so has to be the one the button obeys.
      proposed = validateForSave(edited, {
        // The same relaxation the save itself makes, from the same fact — the
        // check and the button have to agree about what is refusable, or the
        // island tells an operator a document is fine and the save then refuses
        // it. See `provenanceOf`: a `setup` write happens while the claim window
        // is open, which is the way back in the lockout guard exists to protect.
        requireAdministrator: by.origin !== 'setup',
      });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      return pageOf(sectionId, refused(payload, err), 400);
    }

    payload.verdict = compareConfigs(this.config.loadedConfig, proposed);

    if (body.intent !== 'apply') return pageOf(sectionId, payload);

    // Taken before the save, because `ConfigService` is mutable and the refresh
    // below adopts the new version into the very object this would be read from
    // afterwards. Only during the first run: it answers "did this save finish a
    // step", which is a question nothing else on this surface asks.
    const beforeSave = by.origin === 'setup' ? setupStateOf(this.config) : null;

    /*
      The new member's key moved into place, on the one path that stores anything.

      Last, and deliberately: everything above — decoding, the field model, the
      verdict, the refusal that hands a page back — is written against the id the
      route carries, and moving the key earlier would leave `sectionId` naming a
      member the document no longer has. A check that never saves therefore never
      renames, which is right: `intent=check` asks whether this document loads, and
      the answer does not depend on what the member is called.

      Validated again afterwards rather than trusted. `renameProvider` rewrites
      `auth.default_provider` and every grant that named the old id, so the text
      being stored is not the text that was checked a moment ago — and the rule on
      this surface is that what the button obeys is the loader, on the bytes that
      are about to be written.
    */
    let toStore = edited;
    let landing = sectionId;
    if (renamesTo && member && renameMember(doc, member.section, member.id, renamesTo)) {
      toStore = serialise(doc);
      landing = memberSectionId(member.section, renamesTo);
      try {
        validateForSave(toStore, { requireAdministrator: by.origin !== 'setup' });
      } catch (err) {
        if (!(err instanceof ConfigError)) throw err;
        return pageOf(sectionId, refused(payload, err), 400);
      }
    }

    // Check if the stored config is the same as the one we are trying to save. If so, we don't need to save it again.
    if (toStore === state.storedYaml) {
      if (json) {
        payload.pending = false;
        payload.holds_work = false;
        return pageOf(sectionId, payload);
      }
      return { kind: 'redirect', href: `/-/config/${landing}` };
    }

    try {
      const saved = await saveInstanceConfig(caller.tenantId, toStore, by);

      // Adopt it now rather than up to a poll interval from now, so the admin who
      // made the change reads the truth on the page that reports it. Other replicas
      // pick it up on their own timer.
      const refresh = await this.watcher.refresh();

      if (json) {
        payload.saved = { version: saved.version, applied_at: saved.applied_at };
        payload.editing_version = saved.version;
        payload.running_version = this.config.configVersion;
        payload.waiting_on = refresh.waiting;
        // Nothing is held any more: this document *is* the stored one now.
        payload.pending = false;
        payload.holds_work = false;
        return pageOf(sectionId, payload);
      }

      // Redirect rather than render, and for the reason the restore route already
      // does it: a rendered POST response leaves the browser holding a submission
      // it will offer to send again, and `appendConfigVersion` has no dedupe — it
      // is an unconditional `max(version) + 1`. So a reload appended a second
      // version identical to the first, with the operator's own history as the
      // casualty. This was the one write under `/-/` that had not been given the
      // treatment its neighbour has carried since it was written.
      //
      // What the redirect costs is the verdict, and losing it is right rather than
      // merely acceptable: `compareConfigs` exists to be read while the button is
      // still unpressed. Afterwards it describes something that already happened,
      // which is a toast — see the note on that function. The three facts worth
      // keeping all survive the round trip. `saved` is read back out of its row on
      // the GET, `waiting_on` is recomputed there from the stored document anyway,
      // and `running_version` comes off the service.
      /*
        And during the first run, a save that finished a step hands over to the next
        one rather than landing back on the page it was made on.

        The flow is a checklist somebody is working through, and the next move is
        something it already knows; making them find it in the column or on the bar
        is the clicking-around this exists to remove. It forwards only where the
        save *changed* the answer — see `nextSetupPage` — so correcting a value on
        something already configured leaves the operator where they were.

        No `?saved=` on that path, deliberately. The toast says "Saved." and would
        be saying it over a page nobody saved; what confirms the save there is the
        progress bar, whose point for that step is now ticked — which is the better
        answer anyway, because it says *what* was finished rather than that
        something was.
      */
      const forward = beforeSave ? nextSetupPage(beforeSave, this.config, sectionId) : null;

      return { kind: 'redirect', href: forward ?? `/-/config/${landing}?saved=${saved.version}` };
    } catch (err) {
      // `file` mode: refused, not ignored, and not a 404 either — this caller can
      // see the page, so they get the reason rather than a surface that pretends
      // not to exist.
      if (err instanceof ConfigReadOnlyError || err instanceof ConfigError) {
        return pageOf(sectionId, refused(payload, err), 409);
      }
      throw err;
    }
  }
}
