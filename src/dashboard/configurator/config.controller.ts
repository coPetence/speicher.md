/**
 * Dashboard pages and actions for instance config
 *
 * All admin routes, mounted at /-/config
 * The `add` query parameter on a section or member page redirects to create an entry
 * The `check` query parameter triggers diagnostic checks on a section
 * The `saved` query parameter shows which version was last saved
 * `wantsJson` determines HTML vs JSON response; JSON routes return data, HTML routes
 * render pages
 * Restore is gated on the config source being `database`
 */
import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { originOf } from '../../auth/callback-url';
import { callerOf } from '../../auth/caller.middleware';
import { FLOW_TTL_MS } from '../../auth/github.service';
import { ResolvedCaller } from '../../authz/caller';
import { env } from '../../common/env';
import { ConfigError, ConfigReadOnlyError } from '../../common/errors';
import { BRAND_LOGO, checkBrandBytes } from '../../config/brand';
import { brandImagesByHash } from '../../config/brand-store';
import { ConfigService } from '../../config/config.service';
import {
  ConfigVersion,
  configVersionAt,
  listConfigVersions,
  saveInstanceConfig,
} from '../../config/loader';
import { ConfigWatcher } from '../../config/watcher';
import { sendBrandImage } from '../../content-reader/assets.controller';
import { sendHtml } from '../../content-reader/views';
import { DashboardResponder, wantsJson } from '../respond';
import { isPreviewableTemplate, renderTemplatePreview } from '../ui/template-preview';
import { sendConfigBackup } from '../ui/views/config-backup/config-backup';
import { sendConfigEnvironment } from '../ui/views/config-environment/config-environment';
import {
  HistoryPayload,
  sendConfigHistory,
  summarise,
} from '../ui/views/config-history/config-history';
import { sendConfig } from '../ui/views/config-overview/config-overview';
import { sendConfigSection } from '../ui/views/config-section/config-section';
import { sendGithubAppManifest } from '../ui/views/github-app-manifest/github-app-manifest';
import { submitted } from './config-form/decode/body';
import { diffConfigVersions } from './config-form/diff';
import { isConfigSection, isConfigSubsection } from './config-form/fields';
import {
  entryHrefFor,
  isMemberId,
  memberOf,
  memberSectionId,
  nounOf,
} from './config-form/members';
import { readUploads } from './config-form/upload';
import { SectionChecks } from './config-page/checks';
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
import { stampEntryOrigins } from './config-page/origins';
import {
  ConfigBackupPayload,
  ConfigEnvironmentPayload,
  ConfigOverviewPayload,
  ConfigSectionPayload,
} from './config-page/payloads';
import { ConfigSaveService, provenanceOf } from './config-page/save';
import { stampUsage } from './member-usage';

@Controller('-')
export class ConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly page: ConfigPageService,
    private readonly checks: SectionChecks,
    private readonly saves: ConfigSaveService,
    private readonly watcher: ConfigWatcher,
    private readonly respond: DashboardResponder,
    private readonly manifests: GithubAppManifestService,
  ) {}

  /** Config overview page: all section summaries */
  @Get('config')
  async configPage(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const state = await this.page.state(caller);
    this.overviewAnswer(req, res, caller, this.page.overview(state));
  }

  /** Version history page with optional diff between two versions */
  @Get('config/history')
  async configHistory(
    @Req() req: Request,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('restored') restored?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const versions = await listConfigVersions(caller.tenantId);
    const running = this.config.configVersion;

    const toVersion = pickVersion(to, versions[0]?.version ?? null);
    const fromVersion = pickVersion(from, versionBefore(versions, toVersion) ?? toVersion);

    const left = fromVersion === null ? null : await configVersionAt(caller.tenantId, fromVersion);
    const right = toVersion === null ? null : await configVersionAt(caller.tenantId, toVersion);

    this.historyAnswer(req, res, caller, {
      running_version: running,
      from: left?.version ?? null,
      to: right?.version ?? null,
      diff: left && right ? diffConfigVersions(left.yaml, right.yaml) : null,
      restored: pickVersion(restored, null),
      error: null,
      problems: [],
      versions: versions.map((version) => summarise(version, running)),
    });
  }

  /** Backup page: export the current config as a downloadable YAML file */
  @Get('config/backup')
  async configBackup(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    this.backupAnswer(req, res, caller, await this.page.backupPage(await this.page.state(caller)));
  }

  /** Raw YAML download of the current config */
  @Get('config/download')
  async downloadConfig(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const backup = await this.page.backup(await this.page.state(caller));

    res.setHeader('Content-Type', 'application/yaml; charset=utf-8');
    // Forces the browser to download rather than display
    res.setHeader('Content-Disposition', `attachment; filename="${backup.filename}"`);
    // Not persisted; the YAML contains live secrets
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(200).send(backup.yaml);
  }

  /** Environment variable report page */
  @Get('config/environment')
  configEnvironment(@Req() req: Request, @Res() res: Response): void {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    this.environmentAnswer(req, res, caller, this.page.environment());
  }

  /** Restore a previous config version from history */
  @Post('config/restore')
  async restoreConfig(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { version?: unknown },
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const version = pickVersion(body?.version, null);
    const source = version === null ? null : await configVersionAt(caller.tenantId, version);
    if (!source) return this.respond.notFound(req, res);

    try {
      const saved = await saveInstanceConfig(caller.tenantId, source.yaml, provenanceOf(caller));
      await this.watcher.refresh();

      if (wantsJson(req)) {
        res.setHeader('Vary', 'Accept');
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(200).json({ restored: source.version, saved: saved.version });
        return;
      }
      // Redirect back to history so the user sees the restored version highlighted
      return this.redirectTo(res, `/-/config/history?restored=${source.version}`);
    } catch (err) {
      if (err instanceof ConfigReadOnlyError || err instanceof ConfigError) {
        const versions = await listConfigVersions(caller.tenantId);
        return this.historyAnswer(
          req,
          res,
          caller,
          {
            running_version: this.config.configVersion,
            from: null,
            to: null,
            diff: null,
            restored: null,
            error: err.message.split('\n')[0],
            problems: err instanceof ConfigError ? err.problems : [],
            versions: versions.map((v) => summarise(v, this.config.configVersion)),
          },
          409,
        );
      }
      throw err;
    }
  }

  /** Preview a template with demo content, in a frame */
  @Get('config/preview/:template')
  previewTemplate(
    @Req() req: Request,
    @Res() res: Response,
    @Param('template') template: string,
  ): void {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);
    if (!isPreviewableTemplate(template)) return this.respond.notFound(req, res);

    sendHtml(res, (nonce) => renderTemplatePreview(req, this.config, template, nonce), {
      // The preview is shown in an iframe on the same origin
      framedBySelf: true,
    });
  }

  /**
   * A stored brand image, for the thumbnail beside its picker
   */
  @Get('config/brand/:hash')
  async configBrandImage(
    @Req() req: Request,
    @Res() res: Response,
    @Param('hash') hash: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);
    if (!/^[0-9a-f]{64}$/.test(hash)) return this.respond.notFound(req, res);

    const stored = (await brandImagesByHash(caller.tenantId, [hash])).get(hash);
    const inline = this.config.brandImages.find((image) => image.hash === hash);

    const image = stored
      ? { mediaType: stored.media_type, bytes: stored.bytes }
      : inline && { mediaType: inline.mediaType, bytes: inline.bytes };
    if (!image) return this.respond.notFound(req, res);

    if (checkBrandBytes(image.bytes, image.mediaType, BRAND_LOGO)) {
      return this.respond.notFound(req, res);
    }

    sendBrandImage(res, image.mediaType, image.bytes, 'private, no-store');
  }

  /** A single entry within a member (e.g. a group source) */
  @Get('config/:section/:member/:entry')
  async memberEntryPage(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') member: string,
    @Param('entry') entry: string,
    @Query('saved') saved?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const sectionId = `${section}/${member}/${entry}`;
    if (!memberOf(sectionId)) return this.respond.notFound(req, res);

    return this.memberAnswer(req, res, caller, sectionId, saved, undefined, undefined);
  }

  /** A member page (provider, group, source or list entry) */
  @Get('config/:section/:member')
  async memberPage(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') member: string,
    @Query('saved') saved?: string,
    @Query('kind') kind?: string,
    @Query('add') add?: string,
    // Not sent to the view — triggers directory and section checks
    @Query('check') check?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const sectionId = memberSectionId(section, member);
    if (!isMemberId(section, member) && !isConfigSubsection(sectionId)) {
      return this.respond.notFound(req, res);
    }

    const href = typeof add === 'string' ? entryHrefFor(sectionId, add, kind ?? '') : null;
    if (href) return this.redirectTo(res, href);

    return this.memberAnswer(req, res, caller, sectionId, saved, kind, check);
  }

  private async memberAnswer(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    sectionId: string,
    saved: string | undefined,
    kind: string | undefined,
    check: string | undefined,
  ): Promise<void> {
    const state = await this.page.state(caller);

    let payload = await this.page.sectionPayload(state, sectionId);
    if (!payload.section) {
      const draft = this.page.draftPayload(state, sectionId, kind ?? '');
      if (!draft) return this.respond.notFound(req, res);
      payload = draft;
    }

    const version = pickVersion(saved, null);
    const row = version === null ? null : await configVersionAt(caller.tenantId, version);
    if (row) payload.saved = { version: row.version, applied_at: row.applied_at };

    await stampUsage(caller.tenantId, sectionId, payload);
    // Runs directory connectivity check when the user asked for one
    await this.checks.stampDirectoryStatus(payload, check !== undefined);
    await this.checks.stampRepositoryStatus(payload, state.storedYaml, check);
    await this.checks.stampGithubAppLinks(payload, state.storedYaml);
    // Runs storage or mail check when the user asked for one
    await this.checks.stampSectionCheck(payload, state.storedYaml, check !== undefined);
    this.sectionAnswer(req, res, caller, sectionId, payload);
  }

  /** Save a member entry (e.g. a group source) */
  @Post('config/:section/:member/:entry')
  async saveMemberEntry(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') member: string,
    @Param('entry') entry: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const sectionId = `${section}/${member}/${entry}`;
    if (!memberOf(sectionId)) return this.respond.notFound(req, res);

    return this.save(req, res, caller, sectionId);
  }

  /** Save a member (provider, group, source or list entry) */
  @Post('config/:section/:member')
  async saveMember(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') section: string,
    @Param('member') member: string,
    @Query('kind') kind?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const sectionId = memberSectionId(section, member);
    if (!isMemberId(section, member) && !isConfigSubsection(sectionId)) {
      return this.respond.notFound(req, res);
    }

    return this.save(req, res, caller, sectionId, kind);
  }

  private redirectTo(res: Response, href: string): void {
    res.setHeader('Vary', 'Accept');
    res.setHeader('Cache-Control', 'private, no-store');
    res.redirect(303, href);
  }

  /** Section page: list entries, with optional filter and add */
  @Get('config/:section')
  async configSection(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') sectionId: string,
    @Query('saved') saved?: string,
    @Query('add') add?: string,
    @Query('kind') kind?: string,
    @Query('q') q?: string,
    // Not sent to the view — triggers storage or mail checks
    @Query('check') check?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);
    if (!isConfigSection(sectionId)) return this.respond.notFound(req, res);

    const href = typeof add === 'string' ? entryHrefFor(sectionId, add, kind ?? '') : null;
    if (href) return this.redirectTo(res, href);

    const state = await this.page.state(caller);
    // Pass query and kind to pre-filter the entries and select the creation kind
    const payload = await this.page.sectionPayload(
      state,
      sectionId,
      typeof q === 'string' ? q : '',
      typeof kind === 'string' ? kind : '',
    );

    if (add === undefined && typeof kind === 'string' && kind !== '' && payload.section) {
      // When a kind is specified without add, redirect to the first matching entry
      // or to the create page for that kind
      const offered = payload.section.addOps
        .filter((op) => op.opensPage)
        .flatMap((op) => op.typeOptions ?? [])
        .find((option) => option.value === kind && !option.unavailable);
      const landing = offered
        ? entryHrefFor(sectionId, offered.suggest ?? offered.value, kind)
        : null;
      if (landing) return this.redirectTo(res, landing);
    }
    // Shows which config version each entry was introduced in
    await stampEntryOrigins(caller.tenantId, payload);
    // Runs storage or mail check when the user asked for one
    await this.checks.stampSectionCheck(payload, state.storedYaml, check !== undefined);

    const version = pickVersion(saved, null);
    const row = version === null ? null : await configVersionAt(caller.tenantId, version);
    if (row) payload.saved = { version: row.version, applied_at: row.applied_at };

    this.sectionAnswer(req, res, caller, sectionId, payload);
  }

  /** Save a section (applies pending edits) */
  @Post('config/:section')
  async saveConfigSection(
    @Req() req: Request,
    @Res() res: Response,
    @Param('section') sectionId: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);
    if (!isConfigSection(sectionId)) return this.respond.notFound(req, res);

    return this.save(req, res, caller, sectionId);
  }

  private async save(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    sectionId: string,
    kind?: string,
  ): Promise<void> {
    // Multipart uploads are parsed by multer before the save reads the body
    const outcome = await this.saves.save({
      caller,
      sectionId,
      kind,
      json: wantsJson(req),
      readBody: async () => {
        const uploads = await readUploads(req, res);
        return { uploads, body: req.body as Record<string, unknown> };
      },
    });
    switch (outcome.kind) {
      case 'page':
        return this.sectionAnswer(
          req,
          res,
          caller,
          outcome.sectionId,
          outcome.payload,
          outcome.status,
        );
      case 'redirect':
        return this.redirectTo(res, outcome.href);
      case 'json':
        res.status(outcome.status).json(outcome.body);
        return;
      case 'notFound':
        return this.respond.notFound(req, res);
    }
  }

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

      if (outcome.kind === 'redirect') return this.redirectTo(res, installUrl);
      if (outcome.kind !== 'page') return this.respond.notFound(req, res);
      outcome.payload.notice = target.unsavedNotice(installUrl);
      return this.sectionAnswer(
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
    this.sectionAnswer(req, res, caller, sectionId, payload, 400);
  }

  private overviewAnswer(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    payload: ConfigOverviewPayload,
    status?: number,
  ): void {
    sendConfig(this.respond, req, res, caller.isAdmin, payload, status);
  }

  private backupAnswer(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    payload: ConfigBackupPayload,
  ): void {
    sendConfigBackup(this.respond, req, res, caller.isAdmin, payload);
  }

  private environmentAnswer(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    payload: ConfigEnvironmentPayload,
  ): void {
    sendConfigEnvironment(this.respond, req, res, caller.isAdmin, payload);
  }

  private sectionAnswer(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    sectionId: string,
    payload: ConfigSectionPayload,
    status?: number,
  ): void {
    sendConfigSection(
      this.respond,
      req,
      res,
      caller.isAdmin,
      sectionId,
      payload,
      this.config.hasAdministrator,
      status,
    );
  }

  private historyAnswer(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    payload: HistoryPayload,
    status?: number,
  ): void {
    sendConfigHistory(
      this.respond,
      req,
      res,
      caller.isAdmin,
      payload,
      this.config.configSource === 'database',
      status,
    );
  }
}

/** Safely parse a version number from a query string or body value */
function pickVersion(raw: unknown, fallback: number | null): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return fallback;
  const text = String(raw).trim();
  if (text === '') return fallback;
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Find the version immediately before the given one in the list */
function versionBefore(versions: ConfigVersion[], version: number | null): number | null {
  if (version === null) return null;
  const index = versions.findIndex((v) => v.version === version);
  return index === -1 ? null : (versions[index + 1]?.version ?? null);
}
