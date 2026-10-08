/**
 * MCP (Model Context Protocol) API endpoint
 *
 * Exposes a single POST endpoint for all MCP JSON-RPC methods, no SSE streaming
 *
 * Supports protocol version negotiation via `mcp-protocol-version` header
 * CORS-like origin check: rejects requests from origins that do not match
 * `SPEICHER_PUBLIC_URL` when that env var is set
 *
 * Authentication is required unless the instance has public repos configured
 * The WWW-Authenticate challenge is sourced from the OAuth metadata
 */
import { Body, Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callerOf } from '../auth/caller.middleware';
import { challengeHeader } from '../auth/oauth/metadata';
import { instanceUrl } from '../common/env';
import { ConfigService } from '../config/config.service';
import { TOOL_DEFINITIONS, McpTools } from './tools';

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
] as const;

const PREFERRED_PROTOCOL_VERSION = '2025-11-25';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

@Controller('mcp')
export class McpController {
  constructor(
    private readonly tools: McpTools,
    private readonly config: ConfigService,
  ) {}

  /** Reject GET requests: no SSE stream is offered */
  @Get()
  noStream(@Res() res: Response): void {
    res.status(405).setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(rpcError(null, -32601, 'this endpoint does not offer an SSE stream')));
  }

  /** Reject DELETE requests: this endpoint does not use sessions */
  @Delete()
  noSession(@Res() res: Response): void {
    res.status(405).setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(rpcError(null, -32601, 'this endpoint does not use sessions')));
  }

  /** Handle all MCP JSON-RPC methods */
  @Post()
  async rpc(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: JsonRpcRequest,
  ): Promise<void> {
    const caller = callerOf(req);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');

    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && !isPermittedOrigin(origin)) {
      res.status(403).send(JSON.stringify(rpcError(null, -32600, 'origin not permitted')));
      return;
    }

    const declared = req.headers['mcp-protocol-version'];
    if (typeof declared === 'string' && !isSupportedVersion(declared)) {
      res
        .status(400)
        .send(
          JSON.stringify(rpcError(null, -32600, `unsupported MCP-Protocol-Version: ${declared}`)),
        );
      return;
    }

    const id = body?.id ?? null;

    // Require authentication when no public repos exist and the caller is anonymous
    if (caller.identity === null && this.config.publicRepos.length === 0) {
      const challenge = challengeHeader();
      if (challenge !== null) {
        res.status(401).setHeader('WWW-Authenticate', challenge);
        res.send(JSON.stringify(rpcError(id, -32001, 'authentication required')));
        return;
      }
    }

    switch (body?.method) {
      case 'initialize':
        res.status(200).send(
          JSON.stringify(
            rpcResult(id, {
              protocolVersion: negotiateVersion(body.params?.protocolVersion),
              capabilities: { tools: {} },
              serverInfo: { name: 'speicher', version: '0.1.0' },
            }),
          ),
        );
        return;

      case 'notifications/initialized':
        res.status(202).end();
        return;

      case 'tools/list':
        res.status(200).send(JSON.stringify(rpcResult(id, { tools: TOOL_DEFINITIONS })));
        return;

      case 'tools/call': {
        const name = typeof body.params?.name === 'string' ? body.params.name : '';
        const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
        const result = await this.tools.call(caller, name, args);
        res.status(200).send(JSON.stringify(rpcResult(id, result)));
        return;
      }

      case 'ping':
        res.status(200).send(JSON.stringify(rpcResult(id, {})));
        return;

      default:
        res
          .status(200)
          .send(JSON.stringify(rpcError(id, -32601, `method not found: ${body?.method ?? ''}`)));
    }
  }
}

/** True when the version string is in the supported list */
function isSupportedVersion(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

/** Return the requested version if supported, otherwise the preferred default */
function negotiateVersion(requested: unknown): string {
  if (typeof requested === 'string' && isSupportedVersion(requested)) return requested;
  return PREFERRED_PROTOCOL_VERSION;
}

/** True when the origin matches `SPEICHER_PUBLIC_URL`, or no URL is configured */
function isPermittedOrigin(origin: string): boolean {
  const url = instanceUrl();
  if (url === null) return true;
  try {
    return new URL(origin).origin === url.origin;
  } catch {
    return false;
  }
}

function rpcResult(id: string | number | null, result: unknown) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
