/**
 * The config editor: the overview, and the pages of sections, members and entries with their saves
 *
 * The `add` query parameter on a section or member page redirects to create an entry
 * The `check` query parameter triggers diagnostic checks on a section
 * The `saved` query parameter shows which version was last saved
 * `wantsJson` determines HTML vs JSON response; JSON routes return data, HTML routes
 * render pages
 */
import { Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callerOf } from '../../auth/caller.middleware';
import { ResolvedCaller } from '../../authz/caller';
import { configVersionAt } from '../../config/loader';
import { DashboardResponder, wantsJson } from '../respond';
import { sendConfig } from '../ui/views/config-overview/config-overview';
import { isConfigSection, isConfigSubsection } from './config-form/fields';
import { entryHrefFor, isMemberId, memberSectionId } from './config-form/members';
import { readUploads } from './config-form/upload';
import { pickVersion, redirectTo, sendSection } from './config-http';
import { SectionChecks } from './config-page/checks';
import { ConfigPageService } from './config-page/config-page.service';
import { stampEntryOrigins } from './config-page/origins';
import { ConfigSectionPayload } from './config-page/payloads';
import { ConfigSaveService } from './config-page/save';
import { groupsOf, stampGroupUsage, stampUsage } from './member-usage';

@Controller('-')
export class ConfigController {
  constructor(
    private readonly page: ConfigPageService,
    private readonly checks: SectionChecks,
    private readonly saves: ConfigSaveService,
    private readonly respond: DashboardResponder,
  ) {}

  /** Config overview page: all section summaries */
  @Get('config')
  async configPage(@Req() req: Request, @Res() res: Response): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    const state = await this.page.state(caller);
    sendConfig(this.respond, req, res, caller.isAdmin, this.page.overview(state));
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
    if (href) return redirectTo(res, href);

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
    if (href) return redirectTo(res, href);

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
      // A kind set up in one go stays here, with the add modal open on it
      const landing =
        offered && !offered.quickSetup
          ? entryHrefFor(sectionId, offered.suggest ?? offered.value, kind)
          : null;
      if (landing) return redirectTo(res, landing);
    }
    // Shows which config version each entry was introduced in
    await stampEntryOrigins(caller.tenantId, payload);
    await stampGroupUsage(caller.tenantId, payload, groupsOf(state.doc));
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
        return redirectTo(res, outcome.href);
      case 'json':
        res.status(outcome.status).json(outcome.body);
        return;
      case 'notFound':
        return this.respond.notFound(req, res);
    }
  }

  private sectionAnswer(
    req: Request,
    res: Response,
    caller: ResolvedCaller,
    sectionId: string,
    payload: ConfigSectionPayload,
    status?: number,
  ): void {
    sendSection(this.respond, req, res, caller, sectionId, payload, status);
  }
}
