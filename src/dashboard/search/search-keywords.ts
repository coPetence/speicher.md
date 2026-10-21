/**
 * The two hand-maintained tables behind the dashboard search
 *
 * Data rather than code, kept apart from the ranking so a reviewer reading a diff
 * to either list sees nothing else. `admin-search.spec.ts` is what keeps them
 * honest: every page and section must have keywords, every `field:` key and every
 * searchable value must name a control the form renders, and no searchable value
 * may be a secret or a file in any variant
 */

/**
 * Synonym keyword strings for pages, config sections, and settings fields
 *
 * Keys prefixed with `page:`, `section:`, or `field:`
 * Value is comma-separated alternative phrasings a query may match
 */
export const SEARCH_KEYWORDS: Record<string, string> = {
  'page:setup': 'first run, wizard, onboarding, claim, get started, install, initial configuration',
  'page:status':
    'system status, sync, syncing, ingest, ingestion, repositories, last run, freshness, failures, ' +
    'errors, jobs, queue, worker, commit, webhook delivery, not updating, out of date, embedding coverage',
  'page:explain':
    'explain, explain access, why, access, permission, denied, forbidden, missing page, not visible, ' +
    'cannot see, 404, acl, principals, cascade, troubleshoot, debug visibility',
  'page:graph':
    'link graph, graph, links, backlinks, broken links, orphans, edges, tags, related pages',
  'page:analytics':
    'reads, page views, traffic, popular pages, statistics, metrics, visitors, reach, ' +
    'most read, search misses',
  'page:dead-jobs':
    'failed jobs, gave up, retry, stuck, worker errors, dead letter, logs, what went wrong',
  'page:config': 'settings, options, instance configuration, yaml, versions, history, preferences',
  'page:connections':
    'tokens, oauth, revoke, disconnect, connected applications, agents, mcp clients',

  'section:identity':
    'sso, single sign-on, saml, oidc, openid connect, oauth, login, log in, sign in, ' +
    'authentication, auth, provider, entra, azure ad, active directory, microsoft, google, ' +
    'github login, magic link, email link, passwordless, issuer, client id, client secret, ' +
    'session lifetime, directory lookup',
  'section:groups':
    'teams, membership, directory groups, group mapping, object id, team slug, email domain, ' +
    'who is in, grants, roles, ldap, access',
  'section:admins':
    'administrator, admin, owner, superuser, root, operate, who can change settings, ' +
    'lockout, locked out, elevate',
  'section:public':
    'anonymous, unauthenticated, no account, no login, internet, publish, publishing, open, ' +
    'crawlers, robots, seo, sitemap, cache, cdn',
  'section:sources':
    'repositories, repos, content, git, github, gitlab, gitea, forgejo, bitbucket, remote, ' +
    'clone, mirror, branch, webhook, deploy key, ssh key, token, poll, polling, owner, ' +
    'monorepo, add a repository',
  'section:branding':
    'logo, favicon, name, title, colours, colors, template, theme, appearance, look, ' +
    'white label, attribution, footer credit, css',
  'section:reading':
    'link graph, related, hover preview, peek, tags, breadcrumbs, presentation, ' +
    'reading experience, search boost',
  'section:analytics':
    'reads, read counts, counts, page views, traffic, statistics, privacy, gdpr, dsgvo, ' +
    'works council, betrvg, retention, time zone, unique readers, beacon, cookie',
  'section:defaults':
    'include, exclude, globs, glob patterns, ignore files, which files, indexable, ' +
    'cover image, repository defaults',
  'section:mail':
    'email, smtp, mail server, relay, sending, sender address, from address, reply-to, ' +
    'port, tls, starttls, credentials, sendgrid, postmark, ses, office 365, transport',
  'section:notifications':
    'notifications, notices, alerts, alerting, who gets told, email alerts, ' +
    'failed sync, sync error, broken repository, rejected commit, ingest failure, ' +
    'committer, stale, stopped syncing, no longer updating, missing commits, ' +
    'freshness alert, expiring access, expiry, until, access review, offboarding, ' +
    'grant ends, reminder',
  'section:storage':
    'assets, images, attachments, uploads, files, blob, bucket, s3, azure, filesystem, ' +
    'volume, disk, object storage, presigned',
  'section:embedding':
    'semantic search, vector, vectors, embeddings, rag, ai, openai, azure openai, ollama, ' +
    'model, dimensions, pgvector, ann, hnsw, similarity, re-embed',

  'section:branding/logos':
    'logo, logos, favicon, tab icon, browser tab, bookmark icon, image, picture, svg, ' +
    'png, webp, upload, header logo, dark mode logo, dark theme logo, white logo, ' +
    'inverted logo, wordmark, brand mark, square icon',

  'section:branding/appearance':
    'colours, colors, colour scheme, palette, brand colour, accent, background, ' +
    'text colour, dark mode, light mode, font, typeface, typography, serif, ' +
    'monospace, css, tokens, custom theme, house style, syntax highlighting, ' +
    'code colours, callout, admonition, highlight',

  'field:auth.providers.<key>.issuer': 'tenant id, directory id, discovery, well-known, authority',
  'field:auth.providers.<key>.client_secret': 'secret, credentials, app password',
  'field:auth.providers.<key>.groups_claim': 'group claim, roles claim, memberships, claim mapping',
  'field:auth.providers.<key>.subject_claim': 'oid, sub, unique identifier, claim mapping',
  'field:auth.providers.<key>.domains':
    'sign-in routing, home realm discovery, which provider, email domain',
  'field:auth.providers.<key>.session_ttl': 'how long signed in, logout, expiry, re-login',
  'field:auth.providers.<key>.connection_idle_ttl':
    'mcp, claude, connector, reconnect, oauth, refresh token, ai tool',
  'field:auth.providers.<key>.same_browser': 'forwarded link, shared link, device',
  'field:auth.providers.<key>.directory.type': 'graph api, lookup, resolve email, group size',
  'field:auth.default_provider': 'which provider, primary login, default sign in',

  'field:public.repos': 'publish, make public, anonymous access, open a repository',

  'field:forges.<key>.primary': 'url prefix, path segment, which repository is at the root',
  'field:forges.<key>.default_repository_owner':
    'organisation, organization, org, account, namespace, shorter url',
  'field:forges.<key>.private_key': 'github app, pem, credentials',
  'field:forges.<key>.webhook_secret': 'webhook, push, signature, hmac',
  'field:forges.<key>.known_hosts': 'host key, ssh fingerprint, strict host key checking, tofu',
  'field:forges.<key>.repos.<index>.deploy_key': 'ssh key, private key, credentials',
  'field:forges.<key>.repos.<index>.token': 'pat, personal access token, https credentials',
  'field:forges.<key>.repos.<index>.poll_interval': 'how often, refresh, schedule, cron',
  'field:forges.<key>.poll_interval': 'how often, refresh, schedule, cron',
  'field:forges.<key>.repos.<index>.slug': 'url, path, rename, redirect',

  'field:brand.logo': 'image, picture, svg, png, header logo',
  'field:brand.logo_dark': 'dark mode logo, dark theme, night, inverted, white logo',
  'field:brand.icon': 'favicon, tab icon, browser tab, bookmark, shortcut icon, ico',
  'field:theme.template': 'skin, style, appearance, stylesheet',
  'field:attribution': 'credit, footer, published with, white label',

  'field:graph.previews': 'hover, peek, tooltip, link preview',
  'field:graph.terms': 'tags, keywords, topics',

  'field:analytics.enabled': 'tracking, counting, statistics on or off',
  'field:analytics.timezone': 'day boundary, midnight, when a day starts',
  'field:analytics.granularity': 'hourly, per hour, work patterns, detail',
  'field:analytics.unique_readers': 'how many people, distinct, hyperloglog, reach',
  'field:analytics.public_beacon': 'javascript, browser, cdn, cached pages',
  'field:analytics.retention_days': 'delete after, keep for, retention, purge',

  'field:defaults.sync.include': 'glob, pattern, which files, markdown files',
  'field:defaults.sync.exclude': 'glob, pattern, ignore, skip files',
  'field:defaults.retrieval.indexable': 'search, mcp, hide from search, noindex',
  'field:defaults.display.cover': 'hero image, thumbnail, social image',

  'field:mail.host': 'smtp server, relay, mail server',
  'field:mail.from': 'sender, envelope, no-reply address',
  'field:notify.stale_after': 'how long before stale, threshold, quiet period',
  'field:notify.expiry_warning': 'how much notice, lead time, warn before',

  'field:assets.driver': 's3, azure blob, filesystem, object storage, where assets live',
  'field:assets.path': 'volume, mount, directory, disk',
  'field:assets.max_asset_bytes': 'size limit, upload limit, too large',

  'field:embedding.base_url': 'endpoint, api url, openai compatible, azure openai, ollama',
  'field:embedding.api_key': 'openai key, credentials, token',
  'field:embedding.model': 'text-embedding, which model',
  'field:embedding.dimensions': 'width, vector size, pgvector column',
};

/** Schema paths whose current field value is included in search body */
export const SEARCHABLE_VALUES: string[] = [
  'forges.<key>.repos.<index>.id',
  'forges.<key>.repos.<index>.slug',
  'forges.<key>.repos.<index>.branch',
  'forges.<key>.default_repository_owner',
  'forges.<key>.base_url',
  'forges.<key>.app_id',

  'auth.providers.<key>.issuer',
  'auth.providers.<key>.display_name',
  'auth.providers.<key>.domains',
  'auth.providers.<key>.client_id',
  'auth.providers.<key>.directory.tenant_id',

  'public.repos',

  'mail.host',
  'mail.from',
  'mail.reply_to',

  'embedding.base_url',
  'embedding.model',

  'assets.path',
  'assets.bucket',
  'assets.region',
  'assets.endpoint',
  'assets.account',
  'assets.container',
  'assets.client_id',
];
