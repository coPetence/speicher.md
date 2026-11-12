import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { bindBrowser } from '../../auth/browser-binding';
import { callbackUrl, originOf } from '../../auth/callback-url';
import { callerOf } from '../../auth/caller.middleware';
import { GithubAuthService } from '../../auth/github.service';
import { MagicLinkService } from '../../auth/magic-link.service';
import { OidcService } from '../../auth/oidc.service';
import { emailDomain } from '../../auth/sign-in-routing';
import { env } from '../../common/env';
import { Logger, rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { providerType } from '../../config/types';
import { TenancyService } from '../../db/tenancy';
import { JobQueue } from '../../jobs/queue';
import { GITHUB_APP_LOOKUP_FETCH } from '../../github/app-links';
import { githubHosts } from '../../github/hosts';
import { memberSectionId } from '../configurator/config-form/members';
import { sourceConfigFilePath } from '../configurator/config-page/github-app-manifest';
import type { CheckRow, ConfigFileModal } from '../configurator/config-page/payloads';
import { publicRepoRef, starterConfig } from '../configurator/quick-setup/repository-check';
import {
  checkSource,
  configFileTarget,
  githubSourceOf,
  lookUpInstallation,
  rememberedInstallation,
  rememberedListing,
  rememberedRows,
  SourceCheck,
} from '../configurator/quick-setup/source-check';
import { DashboardResponder } from '../respond';
import { StatusService } from '../status/status.service';
import type { RepoStatus } from '../status/status.types';
import {
  ProvableProvider,
  sendSetupAdministrator,
} from '../ui/views/setup/setup-administrator/setup-administrator';
import { sendSetup } from '../ui/views/setup/setup-overview/setup-overview';
import { sendSetupRepository } from '../ui/views/setup/setup-repository/setup-repository';
import { BLOCKING_FIXES, nextFix } from './repository-fix';
import {
  addRepositorySources,
  repositoryKey,
  repositoryMatchText,
  repositoryTable,
} from './repository-table';
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
    private readonly queue: JobQueue,
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
    const discovering = [...(status.instance?.discovering ?? [])];

    // The checks ask GitHub, so the page answers at once and asks for them at the check address
    const checking = req.query.check === '1';
    const fresh = req.query.fresh === '1';
    const configFile = this.configFileModal(req);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const github = new Map<string, Record<string, unknown>>();
    const copies = new Set<string>();
    const origins = new Set<string>();
    for (const id of this.config.forgeIds) {
      const forge = githubSourceOf(this.config.forge(id));
      if (!forge) {
        copies.add(id);
        continue;
      }
      github.set(id, forge);
      const base = typeof forge.base_url === 'string' ? forge.base_url : undefined;
      origins.add(new URL(githubHosts(base).web).origin);
    }
    const checks =
      checking || github.size === 0
        ? new Map(
            await Promise.all(
              [...github].map(
                async ([id, forge]) =>
                  [
                    id,
                    await checkSource(id, forge, this.config, this.fetchImpl, 'setup', fresh),
                  ] as const,
              ),
            ),
          )
        : null;
    const vanished = this.vanished(github, checks, status.repos);
    if (checks && fresh) {
      for (const id of await this.discover(caller.tenantId, vanished)) {
        if (!discovering.includes(id)) discovering.push(id);
      }
    }
    // Far quicker than the checks, so the modal that adds a repository need not wait for them
    if (req.query.installations === '1') {
      await Promise.all(
        [...github].map(([id, forge]) => lookUpInstallation(id, forge, this.fetchImpl)),
      );
    }
    const found = new Map<string, CheckRow[]>(
      checks
        ? [...checks].map(([id, check]) => [id, check.checked_repositories])
        : [...github].map(([id, forge]) => [
            id,
            rememberedRows(id, forge, this.config, this.fetchImpl, 'setup'),
          ]),
    );
    const rows = repositoryTable(
      status.repos.filter((repo) => !vanished.includes(repo)),
      readable,
      found,
      copies,
    );
    const busy = discovering.length > 0 || rows.some((row) => row.sync?.activity);
    const shown = rows.filter((row) => repositoryMatchText(row).includes(query.toLowerCase()));

    const me = identity
      ? {
          name: identity.email ?? identity.displayName ?? identity.subject,
          provider: this.config.providerName(identity.provider),
          groups: caller.internalGroups,
        }
      : null;
    const finished = caller.inSetup !== true;
    const fix = nextFix({
      finished,
      me,
      readable: readable.length > 0,
      sources: this.config.forgeIds,
      checks,
      discovering,
      rows,
      allowsPublic: (repository) => this.config.allowsPublic(publicRepoRef(repository)),
    });
    const address = new URLSearchParams({ check: '1', ...(query ? { q: query } : {}) });
    const blocked = fix !== null && BLOCKING_FIXES.includes(fix.id);

    // The groups to grant are the ones the administrator is in, or every group while they are in none
    const groups =
      caller.internalGroups.length > 0 ? caller.internalGroups : this.config.groupNames;
    sendSetupRepository(this.respond, req, res, caller.isAdmin, {
      finished,
      me,
      fix,
      check_href: checks === null && !blocked ? `${REPOSITORY_STEP_PATH}?${address}` : null,
      can_refresh: github.size > 0,
      add_check_href: `${REPOSITORY_STEP_PATH}?${address}`,
      add_lookup_href: `${REPOSITORY_STEP_PATH}?installations=1`,
      add_sources: addRepositorySources(
        this.config.forgeIds.map((id) => {
          const forge = github.get(id);
          return {
            id,
            github: forge !== undefined,
            installation: forge ? rememberedInstallation(forge, this.fetchImpl) : null,
          };
        }),
        rows,
        found,
      ),
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
      rows: shown,
      snippet: copies.size > 0 ? starterConfig(groups) : null,
      busy,
      readable: readable.length > 0,
    });
  }

  private vanished(
    github: Map<string, Record<string, unknown>>,
    checks: Map<string, SourceCheck> | null,
    synced: RepoStatus[],
  ): RepoStatus[] {
    const listings = new Map<string, { account: string; keys: Set<string> }>();
    for (const [id, forge] of github) {
      const check = checks?.get(id);
      // Only a complete listing says a repository is gone
      const listing = checks
        ? check &&
          !check.unchecked_reason &&
          !check.has_unchecked_repositories &&
          check.installation_account
          ? {
              account: check.installation_account,
              names: check.checked_repositories.map((repo) => repo.name),
            }
          : undefined
        : rememberedListing(forge, this.fetchImpl);
      if (!listing) continue;
      listings.set(id, {
        account: listing.account.toLowerCase(),
        keys: new Set([...listing.names].map(repositoryKey)),
      });
    }

    return synced.filter((repo) => {
      const listing = repo.forge_key ? listings.get(repo.forge_key) : undefined;
      return (
        listing !== undefined &&
        repo.namespace.toLowerCase() === listing.account &&
        !listing.keys.has(repositoryKey(`${repo.namespace}/${repo.slug}`))
      );
    });
  }

  private async discover(tenantId: string, repos: RepoStatus[]): Promise<string[]> {
    const queued = [...new Set(repos.map((repo) => repo.forge_key ?? ''))].filter(Boolean);
    for (const id of queued) {
      await this.queue.enqueue({
        tenantId,
        kind: 'sync-repo-list',
        payload: { forgeKey: id },
        dedupeKey: `sync-repo-list:${id}`,
      });
    }
    return queued;
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

/** The submitted provider, else the sole option: one provider needs no selector */
function pick(submitted: unknown, options: string[]): string | null {
  if (typeof submitted === 'string' && options.includes(submitted)) return submitted;
  return options.length === 1 ? options[0] : null;
}
