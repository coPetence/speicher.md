/**
 * Creating the GitHub App of a source or an identity provider from a manifest:
 * handing the browser over to GitHub, and saving what GitHub sends back
 */
import { Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { originOf } from '../../auth/callback-url';
import { callerOf } from '../../auth/caller.middleware';
import { FLOW_TTL_MS } from '../../auth/github.service';
import { ResolvedCaller } from '../../authz/caller';
import { env } from '../../common/env';
import { ConfigReadOnlyError } from '../../common/errors';
import { ConfigService } from '../../config/config.service';
import { DashboardResponder } from '../respond';
import { sendGithubAppManifest } from '../ui/views/github-app-manifest/github-app-manifest';
import { submitted } from './config-form/decode/body';
import { isMemberId, memberSectionId, nounOf } from './config-form/members';
import { readUploads } from './config-form/upload';
import { redirectTo, sendSection } from './config-http';
import { ConfigPageService } from './config-page/config-page.service';
import {
  GITHUB_APP_FORM_COOKIE,
  GithubAppManifestError,
  GithubAppManifestService,
  MANIFEST_TARGETS,
  appFields,
  carryForm,
  githubAppCallbackPath,
  uploadsOf,
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
      const { handoff, sealedForm } = await this.manifests.start(
        caller.tenantId,
        target,
        // Each App on a page has its own organization field
        (submitted(body, `${app}:owner`) ?? '').trim(),
        originOf(req),
        carryForm(body, uploads),
      );

      res.cookie(GITHUB_APP_FORM_COOKIE, sealedForm, {
        httpOnly: true,
        secure: !env('SPEICHER_INSECURE_COOKIES'),
        sameSite: 'lax',
        path: githubAppCallbackPath(target.sectionId, target.app),
        maxAge: FLOW_TTL_MS,
      });
      sendGithubAppManifest(res, handoff);
    } catch (err) {
      if (!(err instanceof GithubAppManifestError)) throw err;
      return this.manifestRefused(req, res, caller, sectionId, err);
    }
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
        amend: (doc) => writeStoredValues(doc, target, app),
      });
      const installUrl = `${app.html_url}/installations/new`;

      if (outcome.kind === 'redirect') return redirectTo(res, installUrl);
      if (outcome.kind !== 'page') return this.respond.notFound(req, res);
      outcome.payload.notice = target.unsavedNotice(installUrl);
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
    sendSection(this.respond, this.config, req, res, caller, sectionId, payload, 400);
  }
}
