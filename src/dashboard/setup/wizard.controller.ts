/**
 * The setup wizard: pages that walk an instance through first configuration
 *
 * Reachable only by an instance admin (aka. a claimed session)
 * The overview starts the setup; the steps are walked through with the guide bar
 */
import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import type { CheckRow } from '../configurator/config-page/payloads';
import { starterConfig } from '../configurator/quick-setup/repository-check';
import type { ConfigFileModal } from '../configurator/config-page/payloads';
import { sourceConfigFilePath } from '../configurator/config-page/github-app-manifest';
import { memberSectionId } from '../configurator/config-form/members';
import {
  checkSource,
  configFileTarget,
  githubSourceOf,
} from '../configurator/quick-setup/source-check';
import { githubHosts } from '../../github/hosts';
import { DashboardResponder } from '../respond';
import { StatusService } from '../status/status.service';
import { GITHUB_APP_LOOKUP_FETCH } from '../../github/app-links';
import { bindBrowser } from '../../auth/browser-binding';
import { callbackUrl, originOf } from '../../auth/callback-url';
import { callerOf } from '../../auth/caller.middleware';
import { ResolvedCaller } from '../../authz/caller';
import { GithubAuthService } from '../../auth/github.service';
import { MagicLinkService } from '../../auth/magic-link.service';
import { OidcService } from '../../auth/oidc.service';
import { emailDomain } from '../../auth/sign-in-routing';
import { env } from '../../common/env';
import { Logger, rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { providerType } from '../../config/types';
import { TenancyService } from '../../db/tenancy';
import {
  ProvableProvider,
  sendSetupAdministrator,
} from '../ui/views/setup/setup-administrator/setup-administrator';
import { sendSetup } from '../ui/views/setup/setup-overview/setup-overview';
import {
  RepositoryPayload,
  sendSetupRepository,
} from '../ui/views/setup/setup-repository/setup-repository';
import { RepositoryTableRow, repositoryMatchText, repositoryTable } from './repository-table';
import { SetupService } from './setup.service';
import { REPOSITORY_STEP_PATH, SETUP_LATER_COOKIE } from './steps';

/** The setup wizard's pages and the proving login, served under /-/setup */
@Controller('-')
export class SetupWizardController {
  private readonly log: Logger = rootLogger.child('setup');

  constructor(
    private readonly config: ConfigService,
    private readonly oidc: OidcService,
    private readonly github: GithubAuthService,
    private readonly magic: MagicLinkService,
    private readonly tenancy: TenancyService,
    private readonly respond: DashboardResponder,
    private readonly setup: SetupService,
    private readonly status: StatusService,
    @Inject(GITHUB_APP_LOOKUP_FETCH) private readonly fetchImpl: typeof fetch,
  ) {}

  /** The overview, which starts the setup or takes it up again */
  @Get('setup')
  async setupPage(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);
    if (req.cookies?.[SETUP_LATER_COOKIE] !== undefined) {
      res.clearCookie(SETUP_LATER_COOKIE, { path: '/' });
      req.cookies[SETUP_LATER_COOKIE] = undefined;
    }
    sendSetup(this.respond, req, res, caller.isAdmin, { finished: caller.inSetup !== true });
  }

  /** Leave the setup for later: the guide steps back until the overview is opened again */
  @Get('setup/later')
  async later(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin || caller.viaSetup === true) return this.respond.notFound(req, res);
    res.cookie(SETUP_LATER_COOKIE, '1', {
      httpOnly: true,
      secure: !env('SPEICHER_INSECURE_COOKIES'),
      sameSite: 'lax',
      path: '/',
    });
    res.redirect(303, '/-/config');
  }

  @Get('repositories')
  async repositoryPage(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const identity = caller.identity;
    const [status, readable] = await Promise.all([
      this.status.statusPayload(caller, 'all'),
      this.setup.readableRepositories(caller.tenantId, caller.principals),
    ]);
    const discovering = status.instance?.discovering ?? [];

    // The check asks GitHub, so the page answers at once and the table asks for each source's check
    const asked = typeof req.query.check === 'string' ? req.query.check : null;
    const configFile = this.configFileModal(req);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const checks: RepositoryPayload['checks'] = [];
    const found = new Map<string, CheckRow[]>();
    const copies = new Set<string>();
    const origins = new Set<string>();
    for (const id of this.config.forgeIds) {
      const github = githubSourceOf(this.config.forge(id));
      if (!github) {
        copies.add(id);
        continue;
      }
      const base = typeof github.base_url === 'string' ? github.base_url : undefined;
      origins.add(new URL(githubHosts(base).web).origin);
      if (asked !== id) {
        const address = new URLSearchParams({ check: id, ...(query ? { q: query } : {}) });
        checks.push({ id, pending: `${REPOSITORY_STEP_PATH}?${address}` });
        continue;
      }
      const check = await checkSource(id, github, this.config, this.fetchImpl, 'setup');
      found.set(id, check.repositories);
      checks.push({
        id,
        pending: null,
        problem: check.problem,
        empty: !check.problem && check.repositories.length === 0,
        missing: check.missing.length > 0,
        more: check.more,
      });
    }
    const rows = repositoryTable(status.repos, readable, found, copies);
    const busy = discovering.length > 0 || rows.some((row) => row.sync?.activity);
    const shown = rows.filter((row) => repositoryMatchText(row).includes(query.toLowerCase()));

    // The groups to grant are the ones the administrator is in, or every group while they are in none
    const groups =
      caller.internalGroups.length > 0 ? caller.internalGroups : this.config.groupNames;
    sendSetupRepository(this.respond, req, res, caller.isAdmin, {
      finished: caller.inSetup !== true,
      me: identity
        ? {
            name: identity.email ?? identity.displayName ?? identity.subject,
            provider: this.config.providerName(identity.provider),
            groups: caller.internalGroups,
          }
        : null,
      query,
      config_file: configFile,
      picker:
        origins.size > 0
          ? {
              section_id: '',
              id: '',
              repository: '',
              action: '',
              back_href: REPOSITORY_STEP_PATH,
              leads_to: '',
              groups: this.config.groupNames.map((name, _, all) => ({
                name,
                checked: all.length === 1,
              })),
            }
          : null,
      form_origins: [...origins],
      checks,
      rows: shown,
      snippet: copies.size > 0 ? starterConfig(groups) : null,
      discovering,
      busy,
      readable: readable.length > 0,
      status: repositoryStatus(caller, readable, rows, busy),
    });
  }

  /**
   * The modal that picks the groups a new `.speicher.yaml` grants reading to, as the address asks for it over the
   * repositories, or null when it asks for none.
   *
   * @param req the request
   */
  private configFileModal(req: Request): ConfigFileModal | null {
    const id = typeof req.query.config_file === 'string' ? req.query.config_file : null;
    const target = configFileTarget(req.query);
    const forge = id ? githubSourceOf(this.config.forge(id)) : null;
    if (!id || !target || !forge) return null;

    const { web } = githubHosts(typeof forge.base_url === 'string' ? forge.base_url : undefined);
    const groups = this.config.groupNames;
    return {
      section_id: memberSectionId('sources', id),
      id,
      repository: target.repository,
      // Posted where the source's modal posts, which leads on to GitHub
      action: sourceConfigFilePath(id, target.repository, target.branch, 'setup'),
      back_href: REPOSITORY_STEP_PATH,
      leads_to: new URL(web).origin,
      // A single group is the only choice there is, so it starts ticked
      groups: groups.map((name) => ({ name, checked: groups.length === 1 })),
      ...(req.query.picked === 'none' ? { error: 'Pick at least one group.' } : {}),
    };
  }

  /** Complete the setup, once the administrator can read a synced page */
  @Post('setup/complete')
  async complete(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin || caller.viaSetup === true) return this.respond.notFound(req, res);
    if (!(await this.setup.complete(caller.tenantId, caller.principals))) {
      return res.redirect(303, REPOSITORY_STEP_PATH);
    }
    res.clearCookie(SETUP_LATER_COOKIE, { path: '/' });
    res.redirect(303, '/');
  }

  /** The last step: the page whose form posts to /-/setup/prove */
  @Get('setup/administrator')
  async administratorPage(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);
    await this.administratorAnswer(req, res, caller.isAdmin, null);
  }

  /**
   * Starts the login that writes the first administrator on callback: a redirect
   * to the OIDC or GitHub provider, or a magic link sent to the submitted address
   *
   * Refused once an administrator exists, or when no provider is configured:
   * the login would have nothing to write either way
   */
  @Post('setup/prove')
  async prove(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    // Resolve the tenant, then accept the submitted provider or the only one there is
    const tenant = await this.tenancy.resolveTenant(req);
    const chosen = pick(
      req.body?.provider,
      this.provable().map((p) => p.id),
    );

    // Refused before any flow is started: the login would have nothing to write
    if (this.config.hasAdministrator || !chosen) {
      return await this.administratorAnswer(
        req,
        res,
        caller.isAdmin,
        this.config.hasAdministrator
          ? 'An administrator already exists. The instance is closed to further claims.'
          : 'No identity provider is available to sign in. Add one first.',
        400,
      );
    }

    if (providerType(this.config.provider(chosen)!) === 'magic-link') {
      return await this.sendProvingLink(req, res, caller.isAdmin, tenant.id, chosen);
    }

    // The callback writes this login's identity into admins, then returns to the wizard
    // Through callbackUrl, so the redirect_uri matches the one the callback exchanges with
    try {
      const kind = providerType(this.config.provider(chosen)!) === 'github' ? 'github' : 'oidc';
      const service = kind === 'github' ? this.github : this.oidc;
      const url = await service.authorizationUrl(
        tenant.id,
        chosen,
        callbackUrl(req, kind),
        '/-/setup',
        { namesFirstAdmin: true },
      );
      res.redirect(302, url);
    } catch (err) {
      // The provider could not be reached or validated; the page says what to check
      this.log.error('could not start the proving login', {
        provider: chosen,
        error: (err as Error).message,
      });
      await this.administratorAnswer(
        req,
        res,
        caller.isAdmin,
        `Could not reach the "${chosen}" provider. Check its client details and callback URL.`,
        502,
      );
    }
  }

  /**
   * Sends the magic link used to promote first administrator
   *
   * Bound to this browser, so the link only works where the instance was claimed
   */
  private async sendProvingLink(
    req: Request,
    res: Response,
    isAdmin: boolean,
    tenantId: string,
    providerId: string,
  ): Promise<void> {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (emailDomain(email) === null) {
      return await this.administratorAnswer(
        req,
        res,
        isAdmin,
        'Enter your full email address.',
        400,
      );
    }

    await this.magic.request(
      tenantId,
      providerId,
      email,
      originOf(req),
      bindBrowser(req, res),
      '/-/setup',
      { namesFirstAdmin: true },
    );
    await this.administratorAnswer(req, res, isAdmin, null, 200, email);
  }

  private provable(): ProvableProvider[] {
    return this.config.providerShortIds
      .filter((id) => this.config.provider(id) !== undefined)
      .map((id) => ({
        id,
        name: this.config.providerName(id),
        kind: providerType(this.config.provider(id)!) === 'magic-link' ? 'magic-link' : 'redirect',
      }));
  }

  /** Sends the become-administrator page with the providers for the form */
  private async administratorAnswer(
    req: Request,
    res: Response,
    isAdmin: boolean,
    error: string | null,
    status?: number,
    sentTo: string | null = null,
  ): Promise<void> {
    const provable = this.provable();
    sendSetupAdministrator(
      this.respond,
      req,
      res,
      isAdmin,
      { provable, done: this.config.hasAdministrator, error, sentTo },
      await this.formActions(provable),
      status,
    );
  }

  /**
   * The browser holds a form POST's redirect to the page's CSP form-action, so
   * without these the sign-in is refused
   */
  private async formActions(provable: ProvableProvider[]): Promise<string[]> {
    const origins = await Promise.all(
      provable.map(async ({ id, kind }) => {
        if (kind === 'magic-link') return null;
        try {
          return providerType(this.config.provider(id)!) === 'github'
            ? this.github.authorizationOrigin(id)
            : await this.oidc.authorizationOrigin(id);
        } catch (err) {
          // An unreachable provider fails at prove, which says so on the page
          this.log.warn('could not resolve the authorization origin', {
            provider: id,
            error: (err as Error).message,
          });
          return null;
        }
      }),
    );
    return [...new Set(origins.filter((origin): origin is string => origin !== null))];
  }
}

/**
 * repositoryStatus says how far the repository step is, for the note at its foot.
 *
 * @param caller the administrator
 * @param readable the repositories they can read a page of
 * @param rows the rows of the step's table
 * @param busy whether a sync or a discovery is queued or running
 */
function repositoryStatus(
  caller: ResolvedCaller,
  readable: string[],
  rows: RepositoryTableRow[],
  busy: boolean,
): RepositoryPayload['status'] {
  // A page of the configuration once the setup is complete, which says nothing about the setup
  if (caller.inSetup !== true) return null;
  if (readable.length > 0) return null;
  if (!caller.identity) return 'no-administrator';
  if (caller.internalGroups.length === 0) return 'no-group';
  if (busy) return 'syncing';
  if (rows.length === 0) return 'no-repository';
  if (rows.some((row) => row.sync?.state === 'ok' && row.file.level === 'ok')) return 'no-access';
  return 'waiting';
}

/** The submitted provider, else the sole option: one provider needs no selector */
function pick(submitted: unknown, options: string[]): string | null {
  if (typeof submitted === 'string' && options.includes(submitted)) return submitted;
  return options.length === 1 ? options[0] : null;
}
