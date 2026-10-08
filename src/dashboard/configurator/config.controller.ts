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

import { callerOf } from '../../auth/caller.middleware';
import { ResolvedCaller } from '../../authz/caller';
import { ConfigError, ConfigReadOnlyError } from '../../common/errors';
import { ConfigService } from '../../config/config.service';
import {
  ConfigVersion,
  configVersionAt,
  listConfigVersions,
  saveInstanceConfig,
} from '../../config/loader';
import { ConfigWatcher } from '../../config/watcher';
import { sendHtml } from '../../content-reader/views';
import { sendConfigBackup } from '../ui/views/config-backup/config-backup';
import { sendConfigEnvironment } from '../ui/views/config-environment/config-environment';
import {
  HistoryPayload,
  sendConfigHistory,
  summarise,
} from '../ui/views/config-history/config-history';
import { sendConfigSection } from '../ui/views/config-section/config-section';
import { sendConfig } from '../ui/views/config-overview/config-overview';
import { diffConfigVersions } from './config-form/diff';
import { isConfigSection, isConfigSubsection } from './config-form/fields';
import { entryHrefFor, isMemberId, memberOf, memberSectionId } from './config-form/members';
import { readUploads } from './config-form/upload';
import { ConfigPageService } from './config-page/config-page.service';
import { SectionChecks } from './config-page/checks';
import { stampEntryOrigins } from './config-page/origins';
import { ConfigSaveService, provenanceOf } from './config-page/save';
import {
  ConfigBackupPayload,
  ConfigEnvironmentPayload,
  ConfigOverviewPayload,
  ConfigSectionPayload,
} from './config-page/payloads';
import { stampUsage } from './member-usage';
import { DashboardResponder, wantsJson } from '../respond';
import { isPreviewableTemplate, renderTemplatePreview } from '../ui/template-preview';

@Controller('-')
export class ConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly page: ConfigPageService,
    private readonly checks: SectionChecks,
    private readonly saves: ConfigSaveService,
    private readonly watcher: ConfigWatcher,
    private readonly respond: DashboardResponder,
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

    this.backupAnswer(req, res, caller, this.page.backupPage(await this.page.state(caller)));
  }

  /** Raw YAML download of the current config */
  @Get('config/download')
  async downloadConfig(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const backup = this.page.backup(await this.page.state(caller));

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

    let payload = this.page.sectionPayload(state, sectionId);
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
    const payload = this.page.sectionPayload(
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
