/**
 * Creating the GitHub App of a source or an identity provider from a manifest:
 * handing the browser over to GitHub, and saving what GitHub sends back
 */
import { Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callbackUrl, originOf } from '../../auth/callback-url';
import { callerOf } from '../../auth/caller.middleware';
import { GithubAuthService } from '../../auth/github.service';
import { ResolvedCaller } from '../../authz/caller';
import { ConfigReadOnlyError } from '../../common/errors';
import { ConfigService } from '../../config/config.service';
import { DashboardResponder } from '../respond';
import {
  handOffToGithub,
  sendGithubAppManifest,
} from '../ui/views/github-app-manifest/github-app-manifest';
import { submitted } from './config-form/decode/body';
import { isMemberId, memberSectionId, nounOf } from './config-form/members';
import { readUploads } from './config-form/upload';
import { redirectTo, sendSection } from './config-http';
import { ConfigPageService } from './config-page/config-page.service';
import {
  GITHUB_APP_FORM_COOKIE,
  GITHUB_APP_HANDOFF_COOKIE,
  GithubAppManifestError,
  GithubAppManifestService,
  MANIFEST_TARGETS,
  appFields,
  carryForm,
  githubAppCallbackPath,
  githubAppHandoffPath,
  providerInstallPath,
  readyPath,
  uploadsOf,
  writeAppValues,
  writeStoredValues,
} from './config-page/github-app-manifest';
import { ConfigSaveService } from './config-page/save';

@Controller('-')
export class GithubAppManifestController {
  constructor(
    private readonly config: ConfigService,
    private readonly page: ConfigPageService,
    private readonly saves: ConfigSaveService,
    private readonly respond: DashboardResponder,
    private readonly manifests: GithubAppManifestService,
    private readonly github: GithubAuthService,
  ) {}

  /** Hand the browser over to GitHub to create one of the GitHub Apps of a source or an identity provider */
  @Post('config/:section/:member/:app/manifest')
  async startGithubAppManifest(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') member: string,
    @Param('app') app: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const targetOf = MANIFEST_TARGETS[section]?.[app];
    if (!caller.isAdmin || !targetOf || !isMemberId(section, member)) {
      return this.respond.notFound(req, res);
    }
    const sectionId = memberSectionId(section, member);

    const uploads = await readUploads(req, res);
    const body = req.body as Record<string, unknown>;
    const baseUrl = (submitted(body, `${targetOf(member).path.join('.')}.base_url`) ?? '').trim();
    try {
      if (this.config.configSource !== 'database') {
        throw new GithubAppManifestError(new ConfigReadOnlyError(this.config.sourcePath).message);
      }
      if (uploads.refusal) throw new GithubAppManifestError(uploads.refusal);
      const target = targetOf(member, baseUrl);
      const account = submitted(body, `${app}:account`);
      const owner = account === 'personal' ? '' : (submitted(body, `${app}:owner`) ?? '').trim();
      if (account === 'org' && owner === '') {
        throw new GithubAppManifestError('Name the organization the App is created on.');
      }
      const started = await this.manifests.start(
        caller.tenantId,
        target,
        owner,
        originOf(req),
        carryForm(body, uploads),
      );
      handOffToGithub(res, target, started, 'page');
    } catch (err) {
      if (!(err instanceof GithubAppManifestError)) throw err;
      return this.manifestRefused(req, res, caller, sectionId, err);
    }
  }

  /**
   * The page that posts an App's manifest to GitHub, once: its cookie goes with the visit, so Back from GitHub leads to
   * where the flow started instead of to GitHub again
   */
  @Get('config/:section/:member/:app/manifest/handoff')
  async githubAppHandoff(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') member: string,
    @Param('app') app: string,
    @Query('from') from?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const targetOf = MANIFEST_TARGETS[section]?.[app];
    if (!caller.isAdmin || !targetOf || !isMemberId(section, member)) {
      return this.respond.notFound(req, res);
    }
    const target = targetOf(member);

    const sealed: unknown = req.cookies?.[GITHUB_APP_HANDOFF_COOKIE];
    res.clearCookie(GITHUB_APP_HANDOFF_COOKIE, {
      path: githubAppHandoffPath(target.sectionId, app),
    });
    const handoff =
      typeof sealed === 'string'
        ? await this.manifests.handoff(caller.tenantId, target.sectionId, app, sealed)
        : null;
    if (handoff) return sendGithubAppManifest(res, handoff);

    // Visited before, which is how Back from GitHub arrives: the add modal on this kind, or the page the App is for
    if (from === 'modal') return redirectTo(res, `/-/config/${section}?kind=${target.kind}`);
    const stored = (await this.page.state(caller)).doc?.hasIn(target.path) === true;
    return redirectTo(
      res,
      stored
        ? `/-/config/${target.sectionId}`
        : `/-/config/${target.sectionId}?kind=${target.kind}`,
    );
  }

  /** Where GitHub sends the browser back after it created one of the GitHub Apps of a source or an identity provider */
  @Get('config/:section/:member/:app/manifest/callback')
  async completeGithubAppManifest(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') member: string,
    @Param('app') appSegment: string,
    @Query('code') code?: string,
    @Query('state') state?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    const targetOf = MANIFEST_TARGETS[section]?.[appSegment];
    if (!caller.isAdmin || !targetOf || !isMemberId(section, member)) {
      return this.respond.notFound(req, res);
    }
    const sectionId = memberSectionId(section, member);

    const sealedForm: unknown = req.cookies?.[GITHUB_APP_FORM_COOKIE];
    res.clearCookie(GITHUB_APP_FORM_COOKIE, {
      path: githubAppCallbackPath(sectionId, appSegment),
    });
    try {
      if (typeof code !== 'string' || typeof state !== 'string') {
        throw new GithubAppManifestError(
          'GitHub sent the browser back without a code. To create the App, start again on this page.',
        );
      }
      if (typeof sealedForm !== 'string') {
        throw new GithubAppManifestError(
          'The browser came back from GitHub without the details this page sent along. To create the App, start again on this page.',
        );
      }
      const form = await this.manifests.claim(
        caller.tenantId,
        sectionId,
        appSegment,
        state,
        sealedForm,
      );
      const baseUrl = (
        submitted(form.body, `${targetOf(member).path.join('.')}.base_url`) ?? ''
      ).trim();
      const target = targetOf(member, baseUrl);

      const configState = await this.page.state(caller);
      if (target.member === 'new' && configState.doc?.hasIn(target.path)) {
        const noun = nounOf(section);
        throw new GithubAppManifestError(
          `The ${noun} "${member}" already exists, so Speicher did not take over the App GitHub created. To create the App for a new ${noun}, start again with another short id.`,
        );
      }
      const app = await this.manifests.convert(target, code);

      // Saved as the page's Save button saves it, with the App's credentials entered manually
      const outcome = await this.saves.save({
        caller,
        sectionId,
        kind: target.kind,
        json: false,
        readBody: async () => ({
          uploads: uploadsOf(form),
          body: {
            ...form.body,
            ...appFields(target, app),
            [target.switchName]: 'manual',
            intent: 'apply',
          },
        }),
        // A flow started from the add modal carries no page to decode
        decode: form.quick !== true,
        amend: (doc) =>
          form.quick === true
            ? writeAppValues(doc, target, app, form)
            : writeStoredValues(doc, target, app),
      });
      const installUrl = `${app.html_url}/installations/new`;

      if (outcome.kind === 'redirect') {
        // An App that has to be installed goes on to its installation, which returns to the ready modal. A source's
        // and a directory App go to GitHub directly; a provider's goes through the start that lets its return sign in
        if (section !== 'identity' || !target.landsOnReady) return redirectTo(res, installUrl);
        if (app.owner?.isOrganization) return redirectTo(res, providerInstallPath(member));
        // A sign-in App on a personal account has nothing to install. During the first setup its creator signs in
        // with it straight away and becomes the first administrator
        if (
          caller.viaSetup &&
          !this.config.hasAdministrator &&
          app.owner?.isOrganization === false
        ) {
          const signIn = await this.github.authorizationUrl(
            caller.tenantId,
            member,
            callbackUrl(req, 'github'),
            `${readyPath(target.sectionId)}?first_admin=1`,
            { namesFirstAdmin: true },
          );
          return res.redirect(302, signIn);
        }
        return redirectTo(res, readyPath(target.sectionId));
      }
      if (outcome.kind !== 'page') return this.respond.notFound(req, res);
      outcome.payload.notice = target.unsavedNotice(installUrl);
      return sendSection(
        this.respond,
        req,
        res,
        caller,
        outcome.sectionId,
        outcome.payload,
        outcome.status,
      );
    } catch (err) {
      if (!(err instanceof GithubAppManifestError)) throw err;
      return this.manifestRefused(req, res, caller, sectionId, err);
    }
  }

  /** The page the App is created for, with the reason the manifest flow stopped */
  private async manifestRefused(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    sectionId: string,
    err: GithubAppManifestError,
  ): Promise<void> {
    const state = await this.page.state(caller);
    let payload = await this.page.sectionPayload(state, sectionId);
    // A new source or provider is not stored yet, so its page is a draft
    if (!payload.section) {
      const draft = this.page.draftPayload(state, sectionId, 'github');
      if (!draft) return this.respond.notFound(req, res);
      payload = draft;
    }
    payload.error = err.message;
    sendSection(this.respond, req, res, caller, sectionId, payload, 400);
  }
}
