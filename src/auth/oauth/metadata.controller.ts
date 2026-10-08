/**
 * Metadata endpoints for OAuth 2.0 authorization server and protected resource
 *
 * Serves RFC 8414 and RFC 8705 discovery documents at well-known URIs
 * The MCP variant exists because tooling typical of the Model Context Protocol
 * ecosystem looks for it at a different path
 *
 * Not fetched from a database; the document is built from config in the metadata
 * helpers
 */
import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';

import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';

@Controller()
export class OauthMetadataController {
  @Get('.well-known/oauth-protected-resource')
  /** Serve the protected-resource metadata document */
  protectedResource(@Res() res: Response): void {
    this.send(res, protectedResourceMetadata());
  }

  @Get('.well-known/oauth-protected-resource/mcp')
  /** Serve the same document at the MCP-specific well-known path */
  protectedResourceForMcp(@Res() res: Response): void {
    this.send(res, protectedResourceMetadata());
  }

  @Get('.well-known/oauth-authorization-server')
  /** Serve the authorization-server metadata document */
  authorizationServer(@Res() res: Response): void {
    this.send(res, authorizationServerMetadata());
  }

  private send(res: Response, document: Record<string, unknown> | null): void {
    if (document === null) {
      // Metadata helpers return null when the feature is not configured
      res.status(404).setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify({ error: 'not_found' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(JSON.stringify(document));
  }
}
