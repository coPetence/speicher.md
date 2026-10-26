/**
 */
import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callerOf } from '../../auth/caller.middleware';
import { BRAND_IMAGES, checkBrandBytes } from '../../config/brand';
import { brandImagesByHash } from '../../config/brand-store';
import { ConfigService } from '../../config/config.service';
import { configVersionAt } from '../../config/loader';
import { sendBrandImage } from '../../content-reader/assets.controller';
import { sendHtml } from '../../content-reader/views';
import { DashboardResponder } from '../respond';
import { isPreviewableTemplate, renderTemplatePreview } from '../ui/template-preview';
import { sendConfigEnvironment } from '../ui/views/config-environment/config-environment';
import { pickVersion } from './config-http';
import { ConfigPageService } from './config-page/config-page.service';

@Controller('-')
export class ConfigInstanceController {
  constructor(
    private readonly config: ConfigService,
    private readonly page: ConfigPageService,
    private readonly respond: DashboardResponder,
  ) {}

  /** Raw YAML download of a saved version, or of the stored config when the request does not include a specific version */
  @Get('config/download')
  async downloadConfig(
    @Req() req: Request,
    @Res() res: Response,
    @Query('version') version?: string,
  ): Promise<void> {
    const caller = callerOf(req);
    if (!caller.isAdmin) return this.respond.notFound(req, res);

    let source: { yaml: string; version: number | null };
    if (version === undefined) {
      const state = await this.page.state(caller);
      source = { yaml: state.storedYaml, version: state.common.editing_version };
    } else {
      const picked = pickVersion(version, null);
      const stored = picked === null ? null : await configVersionAt(caller.tenantId, picked);
      if (!stored) return this.respond.notFound(req, res);
      source = stored;
    }
    const backup = await this.page.backup(caller.tenantId, source.yaml, source.version);

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

    sendConfigEnvironment(this.respond, req, res, caller.isAdmin, this.page.environment());
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

    const fits = BRAND_IMAGES.some(
      (spec) =>
        spec.types[image.mediaType] !== undefined &&
        checkBrandBytes(image.bytes, image.mediaType, spec) === null,
    );
    if (!fits) return this.respond.notFound(req, res);

    sendBrandImage(res, image.mediaType, image.bytes, 'private, no-store');
  }
}
