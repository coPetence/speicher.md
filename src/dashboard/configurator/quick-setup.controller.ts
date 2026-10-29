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
import { CodedError, ConfigError, ConfigReadOnlyError } from '../../common/errors';
import { env } from '../../common/env';
import { PUBLIC_GROUP_NAME } from '../../common/principals';
import { rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { saveInstanceConfig } from '../../config/loader';
import { GithubProviderConfig, providerType } from '../../config/types';
import { ConfigWatcher } from '../../config/watcher';
import { GITHUB_APP_LOOKUP_FETCH, githubAppLinks, lookupGithubApp } from '../../github/app-links';
import { RepositoryFiles, installationOn, repositoryConfigs } from '../../github/app-installation';
import { githubHosts } from '../../github/hosts';
import { DashboardResponder } from '../respond';
import { setupSteps } from '../setup/steps';
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
import type { CheckModal, CheckRow, ConfigSectionPayload } from './config-page/payloads';
import {
  GithubAppManifestError,
  GithubAppManifestService,
  readyPath,
  sourceCheckPath,
  sourceGroupsPath,
} from './config-page/github-app-manifest';
import { ConfigSaveService, provenanceOf } from './config-page/save';
import { quickFieldName } from './quick-setup/model';
import { primaryOf } from './quick-setup/ready';
import { quickStarterOf } from './quick-setup/registry';
import {
  MissingGroup,
  RepositoryVerdict,
  checkRepository,
  isConfigPath,
  missingGroups,
  starterConfig,
} from './quick-setup/repository-check';

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
    const refuse = (message: string) => {
      payload.add_error = message;
      payload.add_values = {
        [ID_FIELD]: id,
        ...Object.fromEntries(
          Object.entries(input).map(([name, value]) => [quickFieldName(kind, name), value]),
        ),
      };
      sendSection(this.respond, this.config, req, res, caller, section, payload, 400);
    };

    const noun = nounOf(section);
    if (!isMemberId(section, id)) {
      return refuse(`"${id}" is not a short id. ${payload.section.addOps[0]?.nameHint ?? ''}`);
    }
    const member = memberOf(memberSectionId(section, id));
    if (!member || (state.doc && memberExists(state.doc, member))) {
      return refuse(`The ${noun} "${id}" already exists. Pick another short id.`);
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
        return refuse(start.message);
      case 'github-app':
        try {
          const started = await this.manifests.start(
            caller.tenantId,
            start.target,
            start.owner,
            originOf(req),
            { body: {}, parts: {}, quick: true, public: start.public },
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
      // The first setup goes on after the person who finished it became its administrator
      primary: onward
        ? { ...onward, onward: true }
        : primaryOf(caller.viaSetup || promoted ? setupSteps(this.config) : [], section),
    };
    sendSection(this.respond, this.config, req, res, caller, section, payload);
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

    const done = primaryOf(caller.viaSetup ? setupSteps(this.config) : [], section);
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
        pending: { href: withRun(sourceCheckPath(id)) },
        primary: done,
      };
      return sendSection(this.respond, this.config, req, res, caller, section, payload);
    }

    const checked = await this.checkRepositories(id, forge, groupNames(state.doc)[0] ?? null);
    payload.check = {
      ...modal,
      problem: checked.problem,
      repositories: checked.repositories,
      more: checked.more,
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
    sendSection(this.respond, this.config, req, res, caller, section, payload);
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
    const checked = await this.checkRepositories(id, forge, null);
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
    const checked = await this.checkRepositories(id, forge, null);
    await this.sendCreateGroups(req, res, caller, state, id, checked.missing, refusal);
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
    sendSection(this.respond, this.config, req, res, caller, 'sources', payload, error ? 400 : 200);
  }

  /** The rows of a check and the groups it found missing, or why there are none */
  private async checkRepositories(
    sourceId: string,
    forge: Record<string, unknown>,
    group: string | null,
  ): Promise<Pick<CheckModal, 'problem' | 'repositories' | 'more'> & { missing: MissingGroup[] }> {
    const appId = String(forge.app_id);
    const privateKey = String(forge.private_key);
    const { api, web } = githubHosts(
      typeof forge.base_url === 'string' ? forge.base_url : undefined,
    );
    const log = rootLogger.child('config.quick-setup');
    const nothing = { repositories: [], more: false, missing: [] };
    // What the check was doing, so a failure says where it stopped
    let step = 'look up the App';
    try {
      const app = await lookupGithubApp(api, appId, privateKey, this.fetchImpl);
      step = `find the App's installation on ${app.owner.accountName}`;
      const installation = await installationOn(
        api,
        appId,
        privateKey,
        app.owner.accountName,
        this.fetchImpl,
      );
      if (!installation) {
        return {
          ...nothing,
          problem: {
            text: `The App is not installed on **${app.owner.accountName}** yet, so it reads no repository.`,
            href: githubAppLinks(web, app.slug, app.owner).installUrl,
            label: 'Install on GitHub',
          },
        };
      }
      step = 'list the repositories the App reads';
      const read = await repositoryConfigs(api, installation.token, isConfigPath, this.fetchImpl);
      for (const repo of read.repositories) {
        if (repo.files !== null) continue;
        log.warn('could not read the .speicher.yaml files of a repository', {
          source: sourceId,
          repository: repo.fullName,
          error: repo.error,
        });
      }
      const checked = read.repositories.map((repo) => ({
        repo,
        repository: repo.fullName,
        verdict: repo.files ? checkRepository(repo.files, this.config) : null,
      }));
      return {
        more: read.more,
        repositories: checked.map(({ repo, verdict }) => checkRow(repo, verdict, web, group)),
        missing: missingGroups(checked),
      };
    } catch (err) {
      const message = (err as Error).message;
      log.warn('could not check the repositories of a source', {
        source: sourceId,
        step,
        api,
        code: err instanceof CodedError ? err.code : undefined,
        error: message,
      });
      return { ...nothing, problem: { text: `Could not ${step}: ${message}.` } };
    }
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
          this.config,
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
 * checkRow says what the check found in one repository.
 *
 * @param repo the repository and its `.speicher.yaml` files
 * @param verdict what the check found in them, or null when they could not be read
 * @param web the GitHub web host
 * @param group a group of the instance a new `.speicher.yaml` grants reading to, or null when there is none yet
 */
function checkRow(
  repo: RepositoryFiles,
  verdict: RepositoryVerdict | null,
  web: string,
  group: string | null,
): CheckRow {
  const href = `${web}/${repo.fullName}`;
  const name = repo.fullName;
  if (verdict === null) {
    return {
      name,
      href,
      state: 'unreadable',
      text: `GitHub could not be asked for its files: ${repo.error ?? 'no reason given'}`,
    };
  }
  const code = (each: string) => `\`${each}\``;
  switch (verdict.state) {
    case 'unpublished': {
      const create = new URLSearchParams({
        filename: '.speicher.yaml',
        value: starterConfig(group),
      });
      return {
        name,
        href,
        state: 'unpublished',
        text: 'Not published: it has no `.speicher.yaml` yet',
        create_href: `${href}/new/${encodeURIComponent(repo.defaultBranch)}?${create}`,
      };
    }
    case 'invalid':
      return { name, href, state: 'invalid', text: `${code(verdict.file)}: ${verdict.message}` };
    case 'unknown-groups':
      return {
        name,
        href,
        state: 'unknown-groups',
        text: `Missing group: ${verdict.groups
          .map((each) =>
            each.suggestion
              ? `${code(each.name)} (did you mean ${code(each.suggestion)}?)`
              : code(each.name),
          )
          .join(', ')}`,
      };
    case 'ready':
      return {
        name,
        href,
        state: 'ready',
        // A group links to its page; `public` and a count of people have none
        text: `Readable by ${verdict.readers
          .map((each) =>
            / /.test(each) || each === PUBLIC_GROUP_NAME
              ? each
              : `[${each}](/-/config/${memberSectionId('groups', each)})`,
          )
          .join(', ')}`,
      };
  }
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
  if (!isMap(node)) return null;
  const forge = node.toJS(doc) as Record<string, unknown>;
  return forge.type === 'github' &&
    typeof forge.app_id === 'string' &&
    typeof forge.private_key === 'string'
    ? forge
    : null;
}

/** The names of the groups the stored configuration defines */
function groupNames(doc: Document | null): string[] {
  return Object.keys(((doc?.toJS() as Obj | undefined)?.groups as Obj | undefined) ?? {});
}

/** Whether a deferred modal is asked for its result, rather than the page that asks for it */
function ranNow(req: Request): boolean {
  return req.query.run === '1';
}

/**
 * withRun returns the address a deferred modal runs at.
 *
 * @param path the modal's own address
 */
function withRun(path: string): string {
  return `${path}?run=1`;
}
