/**
 * The setup wizard: pages that walk an instance through first configuration
 *
 * Reachable only by an instance admin (aka. a claimed session)
 * The overview lists the steps with their `STEP_PROSE` copy, and cards for what remains
 * Only the last step happens here: prove starts an OIDC or GitHub login whose
 * callback writes the first administrator and closes the claim window
 */
import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { FORGE_TYPES, PROVIDER_KINDS } from '../configurator/config-form/members';
import { DashboardResponder } from '../respond';
import { callbackUrl } from '../../auth/callback-url';
import { callerOf } from '../../auth/caller.middleware';
import { GithubAuthService } from '../../auth/github.service';
import { OidcService } from '../../auth/oidc.service';
import { Logger, rootLogger } from '../../common/logger';
import { ConfigService } from '../../config/config.service';
import { providerType } from '../../config/types';
import { TenancyService } from '../../db/tenancy';
import {
  ProvableProvider,
  sendSetupAdministrator,
} from '../ui/views/setup/setup-administrator/setup-administrator';
import {
  ProviderChoice,
  WizardPayload,
  sendSetup,
} from '../ui/views/setup/setup-overview/setup-overview';
import { MAIL_TRANSPORT_PATH, STEP_PROSE, setupSteps } from './steps';

/** The setup wizard's pages and the proving login, served under /-/setup */
@Controller('-')
export class SetupWizardController {
  private readonly log: Logger = rootLogger.child('setup');

  constructor(
    private readonly config: ConfigService,
    private readonly oidc: OidcService,
    private readonly github: GithubAuthService,
    private readonly tenancy: TenancyService,
    private readonly respond: DashboardResponder,
  ) {}

  /** The overview: every step with prose, and cards for what can still be added */
  @Get('setup')
  async setupPage(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);
    sendSetup(this.respond, req, res, caller.isAdmin, this.payload(null));
  }

  /** The last step: the page whose form posts to /-/setup/prove */
  @Get('setup/administrator')
  async administratorPage(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);
    await this.administratorAnswer(req, res, caller.isAdmin, null);
  }

  /**
   * Starts the OIDC or GitHub login that writes the first administrator on callback
   *
   * Refused once an administrator exists, or when no such provider is configured:
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
          : 'No OpenID Connect or GitHub provider is available to sign in. Add one first.',
        400,
      );
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

  /** The overview payload: steps in order, and cards only for what can still be added */
  private payload(error: string | null): WizardPayload {
    const hasAdmin = this.config.hasAdministrator;

    const steps = setupSteps(this.config).map((step) => ({
      ...step,
      ...STEP_PROSE[step.id],
      action: step.done ? STEP_PROSE[step.id].reviewAction : STEP_PROSE[step.id].action,
    }));

    return {
      steps,
      // Cards vanish once their step is done; finished means an administrator exists
      choices:
        this.config.providerShortIds.length > 0
          ? []
          : identityProviderChoices(this.config.hasMailTransport),
      sources: this.config.hasContentSource ? [] : forgeChoices(),
      finished: hasAdmin,
      error,
    };
  }

  /**
   * The configured OIDC and GitHub providers, the only ones a proving login can use
   *
   * A magic link is left out: it proves a mailbox, not a login this session started
   */
  private provable(): ProvableProvider[] {
    return this.config.providerShortIds
      .filter((id) => {
        const provider = this.config.provider(id);
        return provider !== undefined && providerType(provider) !== 'magic-link';
      })
      .map((id) => ({ id, name: this.config.providerName(id) }));
  }

  /** Sends the become-administrator page with the providers for the form */
  private async administratorAnswer(
    req: Request,
    res: Response,
    isAdmin: boolean,
    error: string | null,
    status?: number,
  ): Promise<void> {
    const provable = this.provable();
    sendSetupAdministrator(
      this.respond,
      req,
      res,
      isAdmin,
      { provable, done: this.config.hasAdministrator, error },
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
      provable.map(async ({ id }) => {
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
 * The provider-kind cards
 * The magic-link card leads to the relay step, since a magic-link provider is
 * refused until mail is configured
 */
function identityProviderChoices(hasMailTransport: boolean): ProviderChoice[] {
  return PROVIDER_KINDS.map((identityProviderKind) => ({
    providerKind: identityProviderKind.value,
    providerLabel: identityProviderKind.label,
    providerMark: identityProviderKind.mark,
    providerHref:
      identityProviderKind.type === 'magic-link' && !hasMailTransport
        ? MAIL_TRANSPORT_PATH
        : `/-/config/identity?kind=${encodeURIComponent(identityProviderKind.value)}`,
  }));
}

/** The content-source kind cards, each opening the add modal on that kind */
function forgeChoices(): ProviderChoice[] {
  return FORGE_TYPES.map((forgeType) => ({
    providerKind: forgeType.value,
    providerLabel: forgeType.label,
    providerMark: forgeType.mark ?? '',
    providerHref: `/-/config/sources?kind=${encodeURIComponent(forgeType.value)}`,
  }));
}

/** The submitted provider, else the sole option: one provider needs no selector */
function pick(submitted: unknown, options: string[]): string | null {
  if (typeof submitted === 'string' && options.includes(submitted)) return submitted;
  return options.length === 1 ? options[0] : null;
}
