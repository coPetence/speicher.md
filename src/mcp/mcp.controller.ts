/**
 * MCP (Model Context Protocol) API endpoint
 *
 * Exposes a single POST endpoint for all MCP JSON-RPC methods, no SSE streaming
 *
 * Supports protocol version negotiation via `mcp-protocol-version` header
 * CORS-like origin check: rejects requests from origins that do not match
 * `SPEICHER_PUBLIC_URL` when that env var is set
 *
 * Two addresses, so a client learns from the first response whether to sign in:
 * - `/mcp` always requires authentication and challenges anonymous callers
 * - `/mcp/public` never challenges and serves only public repos, to anyone
 * Clients only offer OAuth when the first response is a 401, and some never
 * ask again, so one address must not answer both ways
 * The WWW-Authenticate challenge is sourced from the OAuth metadata
 */
import { Body, Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { callerOf } from '../auth/caller.middleware';
import { challengeHeader, mcpResourceIdentifier } from '../auth/oauth/metadata';
import { AuthzService } from '../authz/authz.service';
import { ANONYMOUS, ResolvedCaller } from '../authz/caller';
import { instanceUrl } from '../common/env';
import { ConfigService } from '../config/config.service';
import { TOOL_DEFINITIONS, McpTools, ToolResult } from './tools';

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
    private readonly authz: AuthzService,
  ) {}

  /** Reject GET requests: no SSE stream is offered */
  @Get(['/', 'public'])
  noStream(@Res() res: Response): void {
    res.status(405).setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(rpcError(null, -32601, 'this endpoint does not offer an SSE stream')));
  }

  /** Reject DELETE requests: this endpoint does not use sessions */
  @Delete(['/', 'public'])
  noSession(@Res() res: Response): void {
    res.status(405).setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(rpcError(null, -32601, 'this endpoint does not use sessions')));
  }

  /** Handle all MCP JSON-RPC methods for authenticated callers */
  @Post()
  async rpc(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: JsonRpcRequest,
  ): Promise<void> {
    await this.handle(req, res, body, false);
  }

  /** Handle all MCP JSON-RPC methods anonymously, over public repos only */
  @Post('public')
  async publicRpc(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: JsonRpcRequest,
  ): Promise<void> {
    await this.handle(req, res, body, true);
  }

  private async handle(
    req: Request,
    res: Response,
    body: JsonRpcRequest,
    isPublic: boolean,
  ): Promise<void> {
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
    let caller: ResolvedCaller;

    if (isPublic) {
      if (this.config.publicRepos.length === 0) {
        res
          .status(404)
          .send(
            JSON.stringify(rpcError(id, -32001, `no public documentation, use ${authedUrl()}`)),
          );
        return;
      }
      // Credentials are ignored, so this address reads the same for everyone
      caller = this.authz.resolve({ ...ANONYMOUS, tenantId: callerOf(req).tenantId });
    } else {
      caller = callerOf(req);
      if (caller.identity === null) {
        const challenge = challengeHeader();
        if (challenge !== null) res.setHeader('WWW-Authenticate', challenge);
        res.status(401).send(JSON.stringify(rpcError(id, -32001, 'authentication required')));
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
              ...(isPublic ? { instructions: publicHint() } : {}),
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
        if (isPublic && (name !== 'read' || result.isError === true)) withPublicHint(result);
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

/** The authenticated MCP address, or its path when no base URL is configured */
function authedUrl(): string {
  return mcpResourceIdentifier() ?? '/mcp';
}

/** Tells the model that results are limited, and where the full set is */
function publicHint(): string {
  return (
    'This connection reads public documentation only. To include pages the user has ' +
    `access to, connect to ${authedUrl()} and sign in.`
  );
}

/** Appends the public hint to a tool result, so a misconfigured connector is noticed */
function withPublicHint(result: ToolResult): void {
  result.content.push({ type: 'text', text: publicHint() });
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
