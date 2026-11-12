/**
 * Setting up a new member from the add modal in one go, and the page that says
 * what was set up and what to do next
 */
import { Controller, Get, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Document, isMap } from 'yaml';

import { GITHUB_CALLBACK_PATH, originOf } from '../../auth/callback-url';
import { FLOW_TTL_MS, GITHUB_INSTALL_COOKIE, GithubAuthService } from '../../auth/github.service';
import { callerOf } from '../../auth/caller.middleware';
import { ResolvedCaller } from '../../authz/caller';
import { wordingFor } from '../../common/config-problems';
import { ConfigError, ConfigReadOnlyError } from '../../common/errors';
import { env } from '../../common/env';
import { ConfigService } from '../../config/config.service';
import { saveInstanceConfig } from '../../config/loader';
import { GithubProviderConfig, providerType } from '../../config/types';
import { ConfigWatcher } from '../../config/watcher';
import { GITHUB_APP_LOOKUP_FETCH, githubAppLinks } from '../../github/app-links';
import { githubHosts } from '../../github/hosts';
import { DashboardResponder } from '../respond';
import { REPOSITORY_STEP_PATH, setupSteps } from '../setup/steps';
import { handOffToGithub } from '../ui/views/github-app-manifest/github-app-manifest';
import type { Obj } from './config-form/config-fields';
import { submitted, submittedList } from './config-form/decode/body';
import { loadDocument, serialise, setNodeAt } from './config-form/document';
import { memberExists } from './config-form/member-edits';
import {
  GROUP_NAME,
  GROUP_NAME_HINT,
  entryHrefFor,
  forgeType,
  isMemberId,
  memberOf,
  memberPath,
  memberSectionId,
  nounOf,
  providerFormKind,
} from './config-form/members';
import { redirectTo, sendSection } from './config-http';
import { ConfigPageService } from './config-page/config-page.service';
import { stampEntryOrigins } from './config-page/origins';
import type { ConfigSectionPayload } from './config-page/payloads';
import {
  ConfigFileBack,
  GithubAppManifestError,
  repositoriesConfigFilePath,
  GithubAppManifestService,
  githubAdminOf,
  readyPath,
  sourceCheckPath,
  sourceConfigFilePath,
  sourceGroupsPath,
} from './config-page/github-app-manifest';
import { ConfigSaveService, provenanceOf } from './config-page/save';
import { quickFieldName } from './quick-setup/model';
import { primaryOf } from './quick-setup/ready';
import { quickStarterOf } from './quick-setup/registry';
import { MissingGroup, starterConfig } from './quick-setup/repository-check';
import {
  SourceCheck,
  checkSource,
  configFileTarget,
  githubSourceOf,
} from './quick-setup/source-check';

// The add modal's fields for the kind and the short id
const KIND_FIELD = 'kind';
const ID_FIELD = 'add';

@Controller('-')
export class QuickSetupController {
  constructor(
    private readonly config: ConfigService,
    private readonly page: ConfigPageService,
    private readonly saves: ConfigSaveService,
    private readonly respond: DashboardResponder,
    private readonly manifests: GithubAppManifestService,
    @Inject(GITHUB_APP_LOOKUP_FETCH) private readonly fetchImpl: typeof fetch,
    private readonly github: GithubAuthService,
    private readonly watcher: ConfigWatcher,
  ) {}

  /** Set up a new member as the add modal asked: on an outside service, saved straight away, or on its own page */
  // `-` is never a short id, so the path cannot be a member's own
  @Post('config/:section/-/create')
  async create(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const body = req.body as Record<string, unknown>;
    const kind = (submitted(body, KIND_FIELD) ?? '').trim();
    const id = (submitted(body, ID_FIELD) ?? '').trim();

    const state = await this.page.state(caller);
    const payload = await this.page.sectionPayload(state, section, '', kind);
    const offered = payload.section?.addOps
      .filter((op) => op.opensPage)
      .flatMap((op) => op.typeOptions)
      .find((option) => option.value === kind);
    if (!payload.section || !offered || !payload.editable) {
      return this.respond.notFound(req, res);
    }

    const starter = quickStarterOf(section, kind);
    const input = Object.fromEntries(
      (starter?.setup.fields ?? []).map((field) => [
        field.name,
        submitted(body, quickFieldName(kind, field.name)) ?? '',
      ]),
    );
    const refuse = async (message: string, field?: string): Promise<void> => {
      payload.add_error = message;
      payload.add_error_field = field;
      payload.add_values = {
        [ID_FIELD]: id,
        ...Object.fromEntries(
          Object.entries(input).map(([name, value]) => [quickFieldName(kind, name), value]),
        ),
      };
      await stampEntryOrigins(caller.tenantId, payload);
      sendSection(this.respond, req, res, caller, section, payload, 400);
    };

    const noun = nounOf(section);
    if (!isMemberId(section, id)) {
      return refuse(
        `"${id}" is not a short id. ${payload.section.addOps[0]?.nameHint ?? ''}`,
        ID_FIELD,
      );
    }
    const member = memberOf(memberSectionId(section, id));
    if (!member || (state.doc && memberExists(state.doc, member))) {
      return refuse(`The ${noun} "${id}" already exists. Pick another short id.`, ID_FIELD);
    }
    if (offered.unavailable) return refuse(offered.unavailable);

    // A kind with no quick setup is set up on its page, as the modal's manual button does
    const href = entryHrefFor(section, id, kind);
    if (!starter) return href ? redirectTo(res, href) : this.respond.notFound(req, res);

    if (this.config.configSource !== 'database') {
      return refuse(new ConfigReadOnlyError(this.config.sourcePath).message);
    }
    const start = starter.start(id, input);
    switch (start.kind) {
      case 'refused':
        return refuse(start.message, start.field && quickFieldName(kind, start.field));
      case 'github-app':
        try {
          const started = await this.manifests.start(
            caller.tenantId,
            start.target,
            start.owner,
            originOf(req),
            { body: {}, parts: {}, quick: true, public: start.public },
            githubAdminOf(this.config, caller.identity),
          );
          return handOffToGithub(res, start.target, started, 'modal');
        } catch (err) {
          if (err instanceof GithubAppManifestError) return refuse(err.message);
          throw err;
        }
      case 'save':
        return this.saveNew(req, res, caller, section, id, kind);
    }
  }

  /** What was set up for a member and what to do next, as a modal over the list it joined */
  @Get('config/:section/:member/ready')
  async ready(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') id: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin || !isMemberId(section, id)) return this.respond.notFound(req, res);
    const sectionId = memberSectionId(section, id);
    const member = memberOf(sectionId);

    const state = await this.page.state(caller);
    const node = member && state.doc ? state.doc.getIn(memberPath(member), true) : undefined;
    if (!state.doc || !isMap(node)) return this.respond.notFound(req, res);

    // GitHub lands here after the repositories of an installation changed
    if (section === 'sources' && req.query.setup_action === 'update') {
      return redirectTo(res, REPOSITORY_STEP_PATH);
    }

    const root = state.doc.toJS() as Obj;
    const starter = quickStarterOf(section, kindOf(section, root, id));
    // A member set up on its page has nothing to list
    if (!starter) return redirectTo(res, `/-/config/${sectionId}`);

    const { steps, onward } = await starter.ready({
      section,
      id,
      member: node.toJS(state.doc) as Record<string, unknown>,
      query: Object.fromEntries(
        Object.entries(req.query).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      fetchImpl: this.fetchImpl,
    });
    // Named the first administrator by the sign-in that led here
    const promoted =
      req.query.first_admin === '1' && caller.isAdmin && caller.identity?.provider === id;
    if (promoted) {
      steps.push({ state: 'done', text: 'You are signed in as the first administrator' });
    }
    // Over the list the member joined, which shows it already
    const payload = await this.page.sectionPayload(state, section);
    await stampEntryOrigins(caller.tenantId, payload);
    payload.ready = {
      section_id: sectionId,
      id,
      title: `${titleOf(payload, id)} is set up`,
      steps,
      // The first setup goes on, also after the person who finished it became its administrator
      primary: onward
        ? { ...onward, onward: true }
        : primaryOf(
            caller.inSetup ? setupSteps(this.config, undefined, caller.readsPage === true) : [],
            section,
          ),
    };
    sendSection(this.respond, req, res, caller, section, payload);
  }

  /** Whether the repositories a GitHub source reads are ready to be published, as a modal over the list of sources */
  @Get('config/:section/:member/check')
  async check(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') id: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const state = await this.page.state(caller);
    const forge = caller.isAdmin && section === 'sources' ? githubForgeOf(state.doc, id) : null;
    if (!forge) return this.respond.notFound(req, res);

    const done = primaryOf(
      caller.inSetup ? setupSteps(this.config, undefined, caller.readsPage === true) : [],
      section,
    );
    const payload = await this.page.sectionPayload(state, section);
    await stampEntryOrigins(caller.tenantId, payload);
    const modal = {
      section_id: memberSectionId(section, id),
      id,
      title: 'Check repositories',
    };
    // The page answers at once; asking GitHub runs at the address the modal is swapped for
    if (!ranNow(req)) {
      payload.check = {
        ...modal,
        repositories: [],
        more: false,
        pending: { href: withRun(sourceCheckPath(id), askedFresh(req)) },
        primary: done,
      };
      return sendSection(this.respond, req, res, caller, section, payload);
    }

    const checked = await this.checkRepositories(id, forge, askedFresh(req));
    payload.check = {
      ...modal,
      problem: checked.problem,
      repositories: checked.repositories,
      more: checked.more,
      installation_href: checked.installation_href,
      account: checked.account,
      selection: checked.selection,
      new_repository_href: checked.new_repository_href,
      // Missing groups are created next; otherwise the check is done, or the first setup goes on
      primary:
        checked.missing.length > 0
          ? {
              label: `Create ${checked.missing.length === 1 ? 'the missing group' : `${checked.missing.length} missing groups`}`,
              href: sourceGroupsPath(id),
              onward: true,
            }
          : done,
    };
    sendSection(this.respond, req, res, caller, section, payload);
  }

  /** The groups the repositories of a GitHub source name that do not exist yet, as a modal that creates them */
  @Get('config/:section/:member/groups')
  async missingGroups(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') id: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const state = await this.page.state(caller);
    const forge = caller.isAdmin && section === 'sources' ? githubForgeOf(state.doc, id) : null;
    if (!forge) return this.respond.notFound(req, res);

    // The page answers at once; asking GitHub runs at the address the modal is swapped for
    if (!ranNow(req)) {
      return this.sendCreateGroups(req, res, caller, state, id, [], undefined, {
        href: withRun(sourceGroupsPath(id)),
      });
    }
    const checked = await this.checkRepositories(id, forge);
    await this.sendCreateGroups(req, res, caller, state, id, checked.missing);
  }

  /** Create the groups the modal was sent with, then check the repositories again */
  @Post('config/:section/:member/groups')
  async createGroups(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') id: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const state = await this.page.state(caller);
    const forge = caller.isAdmin && section === 'sources' ? githubForgeOf(state.doc, id) : null;
    if (!forge || !state.doc) return this.respond.notFound(req, res);

    const body = req.body as Record<string, unknown>;
    const names = submittedList(body, 'create');
    // Each new group holds the person creating it, when they asked to be added, or nobody yet
    const identity = caller.identity;
    const members =
      identity && submitted(body, 'add_me') === 'on'
        ? [
            {
              provider: identity.provider,
              subject: identity.subject,
              note: `Added when the group was created${identity.email ? ` (${identity.email})` : ''}`,
            },
          ]
        : [];
    const doc = loadDocument(state.storedYaml);
    let created = 0;
    let refusal: string | null = null;
    for (const name of names) {
      if (!GROUP_NAME.test(name)) {
        refusal = `"${name}" is not a group name. ${GROUP_NAME_HINT}`;
        break;
      }
      if (doc.hasIn(['groups', name])) continue;
      setNodeAt(doc, ['groups', name], members);
      created += 1;
    }

    if (!refusal && created > 0) {
      try {
        await saveInstanceConfig(caller.tenantId, serialise(doc), provenanceOf(caller));
        await this.watcher.refresh();
      } catch (err) {
        if (!(err instanceof ConfigError) && !(err instanceof ConfigReadOnlyError)) throw err;
        refusal = err instanceof ConfigError ? wordingFor(err.summary, 'dashboard') : err.message;
      }
    }
    if (!refusal) return redirectTo(res, sourceCheckPath(id));

    // Refused: the modal again, with why
    const checked = await this.checkRepositories(id, forge);
    await this.sendCreateGroups(req, res, caller, state, id, checked.missing, refusal);
  }

  /** The groups a new `.speicher.yaml` grants reading to, as a modal over the list of sources */
  @Get('config/:section/:member/config-file')
  async configFile(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') id: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const state = await this.page.state(caller);
    const forge = caller.isAdmin && section === 'sources' ? githubForgeOf(state.doc, id) : null;
    const target = configFileTarget(req.query);
    if (!forge || !target) return this.respond.notFound(req, res);

    // A single group is the only choice there is, so it starts ticked
    const groups = groupNames(state.doc);
    await this.sendConfigFile(
      req,
      res,
      caller,
      state,
      id,
      forge,
      target,
      groups.length === 1 ? groups : [],
    );
  }

  /** Open GitHub's new-file page with a `.speicher.yaml` that grants reading to the picked groups */
  @Post('config/:section/:member/config-file')
  async createConfigFile(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') id: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const state = await this.page.state(caller);
    const forge = caller.isAdmin && section === 'sources' ? githubForgeOf(state.doc, id) : null;
    const target = configFileTarget(req.query);
    if (!forge || !target) return this.respond.notFound(req, res);

    const known = groupNames(state.doc);
    const picked = submittedList(req.body as Record<string, unknown>, 'grant').filter((name) =>
      known.includes(name),
    );
    // Asked again over the page the modal was opened on
    if (picked.length === 0 && target.back === 'setup') {
      return redirectTo(
        res,
        `${repositoriesConfigFilePath(id, target.repository, target.branch)}&picked=none`,
      );
    }
    if (picked.length === 0) {
      return this.sendConfigFile(
        req,
        res,
        caller,
        state,
        id,
        forge,
        target,
        [],
        'Pick at least one group.',
      );
    }

    const { web } = githubHosts(typeof forge.base_url === 'string' ? forge.base_url : undefined);
    const create = new URLSearchParams({
      filename: '.speicher.yaml',
      value: starterConfig(picked),
    });
    redirectTo(
      res,
      `${web}/${target.repository}/new/${encodeURIComponent(target.branch)}?${create}`,
    );
  }

  /** The list of sources with the modal that picks the groups of a new `.speicher.yaml` open over it */
  private async sendConfigFile(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    state: Awaited<ReturnType<ConfigPageService['state']>>,
    id: string,
    forge: Record<string, unknown>,
    target: { repository: string; branch: string; back: ConfigFileBack },
    checked: string[],
    error?: string,
  ): Promise<void> {
    const { web } = githubHosts(typeof forge.base_url === 'string' ? forge.base_url : undefined);
    const payload = await this.page.sectionPayload(state, 'sources');
    await stampEntryOrigins(caller.tenantId, payload);
    payload.config_file = {
      section_id: memberSectionId('sources', id),
      id,
      repository: target.repository,
      action: sourceConfigFilePath(id, target.repository, target.branch, target.back),
      back_href: target.back === 'setup' ? REPOSITORY_STEP_PATH : sourceCheckPath(id),
      leads_to: new URL(web).origin,
      groups: groupNames(state.doc).map((name) => ({ name, checked: checked.includes(name) })),
      ...(error ? { error } : {}),
    };
    sendSection(this.respond, req, res, caller, 'sources', payload, error ? 400 : 200);
  }

  /** The list of sources with the modal that creates missing groups open over it */
  private async sendCreateGroups(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    state: Awaited<ReturnType<ConfigPageService['state']>>,
    id: string,
    missing: MissingGroup[],
    error?: string,
    pending?: { href: string },
  ): Promise<void> {
    const payload = await this.page.sectionPayload(state, 'sources');
    await stampEntryOrigins(caller.tenantId, payload);
    payload.create_groups = {
      section_id: memberSectionId('sources', id),
      id,
      action: sourceGroupsPath(id),
      back_href: sourceCheckPath(id),
      me: caller.identity
        ? (caller.identity.email ?? caller.identity.displayName ?? caller.identity.subject)
        : null,
      groups: missing,
      ...(error ? { error } : {}),
      ...(pending ? { pending } : {}),
    };
    sendSection(this.respond, req, res, caller, 'sources', payload, error ? 400 : 200);
  }

  /** The rows of a check and the groups it found missing, or why there are none */
  private async checkRepositories(
    sourceId: string,
    forge: Record<string, unknown>,
    fresh = false,
  ): Promise<SourceCheck> {
    return checkSource(sourceId, forge, this.config, this.fetchImpl, 'check', fresh);
  }

  /**
   * Hand the browser to GitHub to install a provider's App. The installation comes back through the sign-in callback,
   * which only this browser's cookie ties to this start; during the first setup, it names the person who installed the
   * App the first administrator.
   */
  @Get('config/:section/:member/install')
  async install(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') id: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin || section !== 'identity' || !isMemberId(section, id)) {
      return this.respond.notFound(req, res);
    }
    const configured = this.config.provider(id);
    const provider =
      configured && providerType(configured) === 'github'
        ? (configured as GithubProviderConfig)
        : undefined;
    const app = provider?.app;
    if (!provider || !app) return this.respond.notFound(req, res);

    const sectionId = memberSectionId(section, id);
    const state = await this.github.startInstall(caller.tenantId, id, readyPath(sectionId), {
      namesFirstAdmin: caller.viaSetup && !this.config.hasAdministrator,
    });
    res.cookie(GITHUB_INSTALL_COOKIE, state, {
      httpOnly: true,
      secure: !env('SPEICHER_INSECURE_COOKIES'),
      sameSite: 'lax',
      path: GITHUB_CALLBACK_PATH,
      maxAge: FLOW_TTL_MS,
    });
    const { web } = githubHosts(provider.base_url);
    redirectTo(
      res,
      githubAppLinks(web, app.slug, {
        accountName: app.owner_account,
        isOrganization: app.owner_is_organization,
      }).installUrl,
    );
  }

  /** Save a new member with nothing but its kind, as a quick setup that asks no more does */
  private async saveNew(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    section: string,
    id: string,
    kind: string,
  ): Promise<void> {
    const sectionId = memberSectionId(section, id);
    const outcome = await this.saves.save({
      caller,
      sectionId,
      kind,
      json: false,
      decode: false,
      readBody: async () => ({
        uploads: { parts: new Map(), refusal: null },
        body: { intent: 'apply' },
      }),
    });
    switch (outcome.kind) {
      case 'redirect':
        return redirectTo(res, readyPath(sectionId));
      case 'page':
        // Refused: the new member's page says why, as its Save button would
        return sendSection(
          this.respond,
          req,
          res,
          caller,
          outcome.sectionId,
          outcome.payload,
          outcome.status,
        );
      default:
        return this.respond.notFound(req, res);
    }
  }
}

/** The kind of a stored member, as the add modal names it */
function kindOf(section: string, root: Obj, id: string): string {
  if (section === 'identity') return providerFormKind(root, id);
  if (section === 'sources') return forgeType(root, id);
  return '';
}

/** The name the list shows for a member, or its short id */
function titleOf(payload: ConfigSectionPayload, id: string): string {
  return payload.section?.entries.find((entry) => entry.href.endsWith(`/${id}`))?.title ?? id;
}

/**
 * githubForgeOf returns a stored GitHub source with an App, or null.
 *
 * @param doc the stored configuration
 * @param id the source's short id
 */
function githubForgeOf(doc: Document | null, id: string): Record<string, unknown> | null {
  if (!doc || !isMemberId('sources', id)) return null;
  const node = doc.getIn(['forges', id], true);
  return isMap(node) ? githubSourceOf(node.toJS(doc)) : null;
}

/** The names of the groups the stored configuration defines */
function groupNames(doc: Document | null): string[] {
  return Object.keys(((doc?.toJS() as Obj | undefined)?.groups as Obj | undefined) ?? {});
}

/** Whether a deferred modal is asked for its result, rather than the page that asks for it */
function ranNow(req: Request): boolean {
  return req.query.run === '1';
}

function askedFresh(req: Request): boolean {
  return req.query.fresh === '1';
}

/**
 * withRun returns the address a deferred modal runs at.
 *
 * @param path the modal's own address
 * @param fresh whether the run asks GitHub for everything
 */
function withRun(path: string, fresh = false): string {
  return `${path}?run=1${fresh ? '&fresh=1' : ''}`;
}
