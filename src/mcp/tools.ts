/**
 * MCP tool definitions and dispatch
 *
 * Three tools: search, read, list, all read-only, all scoped to the caller's
 * permissions
 *
 * Every tool returns plain text. Markdown is rendered client-side.
 */
import { Injectable } from '@nestjs/common';

import { AnalyticsService } from '../dashboard/analytics/analytics.service';
import { ResolvedCaller } from '../authz/caller';
import { PageRepository } from '../authz/content/pages.repository';
import { SearchHit } from '../authz/content/types';
import { splitPath } from '../common/slug';
import { RoutingService, repoRefOf } from '../content-reader/routing';
import { SearchService } from '../content-reader/search/search.service';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const READS_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export const TOOL_DEFINITIONS = [
  {
    name: 'search',
    title: 'Search documentation',
    annotations: { title: 'Search documentation', ...READS_ONLY },
    description:
      'Full-text search of documentation pages. Results include page path, title and a ' +
      'matching passage; returns `No results.` when nothing matches.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The text to search for.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        path_prefix: {
          type: 'string',
          description:
            'Limit search to pages under this path, e.g. `/javascript/sdk`. Returns `No ' +
            'results.` if the path does not exist.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    title: 'Read a page',
    annotations: { title: 'Read a page', ...READS_ONLY },
    description:
      'Read a documentation page by path and return its full content as markdown. ' +
      'Returns an error if the path does not resolve to a page.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The path of the documentation page to read, e.g. `/javascript/sdk/overview`.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list',
    title: 'List documentation',
    annotations: { title: 'List documentation', ...READS_ONLY },
    description:
      'List documentation pages and repositories at a path. Without a path, lists all ' +
      'visible repositories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Path within the documentation tree to list. Omit or set to `/` to list all ' +
            'repositories.',
        },
      },
      additionalProperties: false,
    },
  },
] as const;

@Injectable()
export class McpTools {
  constructor(
    private readonly pages: PageRepository,
    private readonly routing: RoutingService,
    private readonly search: SearchService,
    private readonly analytics: AnalyticsService,
  ) {}

  async call(
    caller: ResolvedCaller,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    switch (name) {
      case 'search':
        return this.doSearch(caller, args);
      case 'read':
        return this.doRead(caller, args);
      case 'list':
        return this.doList(caller, args);
      default:
        return errorResult(`unknown tool "${name}"`);
    }
  }

  private async doSearch(
    caller: ResolvedCaller,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) return errorResult('`query` is required');
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 50) : 10;

    let repoId: string | undefined;
    let pathPrefix: string | undefined;
    if (typeof args.path_prefix === 'string' && args.path_prefix.trim()) {
      const route = await this.resolvePath(caller, args.path_prefix);

      if (!route) return okResult('No results.');
      repoId = route.repoId;

      pathPrefix = route.slugPath === '' ? undefined : route.slugPath;
    }

    const hits = await this.search.search(caller, query, {
      limit,
      repoId,
      pathPrefix,
      retrievalOnly: true,
    });
    if (hits.length === 0) {
      this.analytics.recordSearchMiss(caller, query);
      return okResult('No results.');
    }

    const lines = hits.map((hit) => {
      const path = this.routing.publicPathFor(
        { namespace: hit.repo_namespace, slug: hit.repo_slug, forge_key: hit.forge_key },
        hit.slug_path,
      );
      return `${path}\n  ${hit.title}\n  ${passageOf(hit)}`;
    });
    return okResult(lines.join('\n\n'));
  }

  private async doRead(caller: ResolvedCaller, args: Record<string, unknown>): Promise<ToolResult> {
    const path = typeof args.path === 'string' ? args.path : '';
    if (!path.trim()) return errorResult('`path` is required');

    const route = await this.resolvePath(caller, path);

    if (!route) return errorResult(`No document at ${path}.`);

    const page = await this.pages.getPage(
      caller.principals,
      caller.tenantId,
      route.repoId,
      route.slugPath,
    );
    if (!page) return errorResult(`No document at ${path}.`);

    this.analytics.recordPageView(caller, route.repoId, page.slug_path, 'mcp', page.is_public);

    const base = this.routing.publicBaseFor(repoRefOf(route));

    const markdown = page.markdown.split('/~repo~').join(base);
    return okResult(`# ${page.title}\n\n${markdown}`);
  }

  private async doList(caller: ResolvedCaller, args: Record<string, unknown>): Promise<ToolResult> {
    const path = typeof args.path === 'string' ? args.path.trim() : '';

    if (path === '' || path === '/') {
      const repos = await this.pages.listVisibleRepos(caller.principals, caller.tenantId);
      if (repos.length === 0) return okResult('Nothing available.');
      return okResult(
        repos
          .map(
            (repo) =>
              `${this.routing.publicBaseFor({
                namespace: repo.namespace,
                slug: repo.slug,
                forge_key: repo.forge_key,
              })}  (repository) ${repo.title}`,
          )
          .join('\n'),
      );
    }

    const route = await this.resolvePath(caller, path);
    if (!route) return errorResult(`Nothing at ${path}.`);

    const visible = await this.pages.folderVisible(
      caller.principals,
      caller.tenantId,
      route.repoId,
      route.slugPath,
    );
    if (!visible) return errorResult(`Nothing at ${path}.`);

    const children = await this.pages.listChildren(
      caller.principals,
      caller.tenantId,
      route.repoId,
      route.slugPath,
    );
    if (children.length === 0) return okResult('Nothing available.');

    const base = this.routing.publicBaseFor(repoRefOf(route));
    return okResult(
      children
        .map((child) => `${base}/${child.slug_path}  (${child.kind}) ${child.title}`)
        .join('\n'),
    );
  }

  private async resolvePath(caller: ResolvedCaller, path: string) {
    const segments = splitPath(path);
    if (segments === null) return null;
    const route = await this.routing.resolve(caller.tenantId, segments);

    return route && !route.redirectTo ? route : null;
  }
}

function okResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function passageOf(hit: SearchHit): string {
  if (hit.chunk_text !== null) {
    return `passage ${hit.chunk_ord} — ${collapse(hit.chunk_text)}`;
  }
  return collapse(hit.snippet.replace(/<\/?mark>/g, ''));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
