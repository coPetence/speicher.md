<div align="center"> 
  <h1>Speicher.md</h1>
  <p><strong>Git-native · Markdown · Per-folder access control · SSO (OIDC / Entra ID) · MCP server · Hybrid search · Self-hosted</strong></p>
  <p>
    <a href="https://speicher.md">Website</a> ·
    <a href="https://github.com/coPetence/speicher.md/releases/latest">Download</a> ·
    <a href="#Self-Hosting">Start self-hosting</a> ·
    <a href="https://docs.speicher.md">Docs</a> ·
  </p>
</div>

# What is Speicher.md?

Speicher.md is a tool made for sharing your markdown files for documentation purposes or just to share some files from your Obisidan vault with others.
Speicher.md uses any simple git repositories (hosted Github for example) as the source to ensure version control and wide compatibility.
Our tool is specifically made to allow sharing your markdown files publicly and also easily with groups (or singular persons) registered on one of our supported identity providers (Github, Microsoft Entra, Google). Using identity providers allows implementing fine grained control over which users / groups see which files, as long as they are registered on any of these platforms; so no account on Speicher.md directly is required. You can also register the Speicher.md mcp server with your AI agent to chat with your documentation as context.
Speicher.md simply parses the markdown files and converts them to pure HTML and CSS, therefore every page also works with javascript disabled.
Migrating from documentation tools like Docusaurus or Starlight? Speicher.md reads the Markdown your static site generator already uses, including Docusaurus and Starlight sidebar ordering. Keep your repo and your workflow, and add access control on top.

## Overview:

- Sharing markdown files with fine grained access control (users or groups)
- No javascript on the frontend
- Git repository as source allows for version control
- No new account needed, sign in via identity providers (Github, Microsoft Entra, Google)
- Reproduceability with .speicher.instance.yaml as configuration file for seeding
- Mcp server for AI agent integration
- Fuzzy search your whole documentation

## Environment variables

Every variable is declared in `src/common/env.ts`, and this table is generated from it with `npm run docs:env`. A `SPEICHER_*` variable that is set but not declared stops the process from starting, so the prefix is reserved: a `${VAR}` reference in the instance config must use a name outside it.

<!-- generated: env-vars — npm run docs:env -->

<!-- prettier-ignore -->
| Knob | Default | Read by | |
| ---- | ------- | ------- | - |
| `SPEICHER_CONFIG` | `./speicher.instance.yaml` | web + worker | Path to the instance configuration YAML file. Must exist when `SPEICHER_CONFIG_SOURCE` is `file`. |
| `SPEICHER_CONFIG_SOURCE` | `file` | web + worker | Where the instance configuration is read from: `file` or `database`. `file` mode is read-only and requires a restart to pick up changes. |
| `SPEICHER_CONFIG_POLL` | `10s` | web + worker | How often to check the database for a newer configuration version, as a duration like `15m`. Set to `0` to disable polling. |
| `SPEICHER_DATABASE_URL` | `postgres://speicher:speicher@127.0.0.1:55432/speicher` | web + worker | PostgreSQL connection string. The database must be reachable at boot; a missing or refused connection prevents startup. |
| `SPEICHER_DB_POOL` | `10` | web + worker | Maximum connections in the PostgreSQL connection pool. Raise when the instance serves many concurrent requests. |
| `SPEICHER_ASSET_PATH` | `./var/assets` | web + worker | Directory where uploaded assets are stored on disk. Must be writable by the process. |
| `SPEICHER_MIRROR_ROOT` | `./var/mirrors` | worker | Root directory for git mirrors. Must be writable and have enough disk space for cloned repositories. |
| `SPEICHER_SYNC_CONCURRENCY` | `4` | worker | Maximum number of repositories synced at the same time. Raise for faster indexing on capable hardware. |
| `SPEICHER_RECONCILE_INTERVAL` | `15m` | worker | How often the reconciler checks every tracked repository against its remote, as a duration like `15m`. Shorter intervals catch changes faster but increase load. |
| `SPEICHER_DISCOVER_INTERVAL` | `6h` | worker | How often to scan the forge for new repositories, as a duration like `6h`. Already-tracked repos are reconciled at `SPEICHER_RECONCILE_INTERVAL` regardless. |
| `SPEICHER_PUBLIC_URL` | — | web + worker | The public URL of this instance, used in webhook deliveries, magic links, and the sitemap. When unset, the request host is used instead. |
| `SPEICHER_ANON_RATE_LIMIT` | `60` | web | Maximum requests per minute from an anonymous caller per client IP. Signed-in callers are exempt; set to `0` to disable rate limiting. |
| `SPEICHER_PUBLIC_MAX_AGE` | `60` | web | Cache-Control `max-age` in seconds for anonymous responses. Set to `0` to disable public caching. |
| `SPEICHER_TRUST_PROXY` | `loopback` | web | Express `trust proxy` setting. Set to the proxy's address or `true` when running behind a reverse proxy so client IPs resolve correctly. |
| `SPEICHER_LOG_LEVEL` | `info` | web + worker | Minimum log level to emit: `debug`, `info`, `warn`, or `error`. SQL queries are logged only at `debug` level. |
| `SPEICHER_DEV_LOGIN` | `false` | web | Show a development sign-in form that issues a session for any typed identity, without authentication. Never enable in production. |
| `SPEICHER_INSECURE_COOKIES` | `false` | web | Omit the Secure flag on cookies, allowing them over HTTP. Never enable in production; without this flag, modern browsers refuse cookies over plain HTTP. |
| `PORT` | `3000` | web | TCP port the HTTP server listens on. |

<!-- /generated: env-vars -->

## First Startup

Start up the container:

```bash
docker compose up -d
```

Assuming you have not set up an identity provider in the .speicher.instance.yaml file, wait for `docker compose logs -f web worker` to show:

```
no instance configuration; serving the claim page
listening
```

Access the Speicher.md instance in your browser, where you will be greated by a token (such as [link]). This token is used to verify your browser session for the initial setup by executing the following on the Speicher.md host:

```bash
docker compose exec web speicher claim <your-token>
```

If you need further help, apart from the onboarding, setting up an identity provider please refer to the documentation [link]

# License

Speicher.md is [BSL 1.1 licensed](LICENCE).
