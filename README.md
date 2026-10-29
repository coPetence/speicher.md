<div align="center">
  <img src=".github/assets/banner.svg" alt="Speicher.md" width="600">
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

Every variable is declared in `src/common/env.ts`, and this table is generated from it with `npm run docs:generate`. A `SPEICHER_*` variable that is set but not declared stops the process from starting, so the prefix is reserved: a `${VAR}` reference in the instance config must use a name outside it.

<!-- generated: env-vars -->
<!-- prettier-ignore-start -->
| Variable | Default | Read by | Description |
| -------- | ------- | ------- | ----------- |
| `SPEICHER_CONFIG` | `./speicher.instance.yaml` | web + worker | Instance YAML file path. The file must exist when `SPEICHER_CONFIG_SOURCE` is `file`. |
| `SPEICHER_CONFIG_SOURCE` | `file` | web + worker | Configuration source: `file` or `database`. File mode is read-only; restart to apply changes. |
| `SPEICHER_CONFIG_POLL` | `10s` | web + worker | Interval between database configuration checks (e.g. `15m`). Use `0` to disable polling. |
| `SPEICHER_DATABASE_URL` | `postgres://speicher:speicher@127.0.0.1:55432/speicher` | web + worker | PostgreSQL connection URL. Startup fails if the database is unreachable. |
| `SPEICHER_DB_POOL` | `10` | web + worker | Maximum number of PostgreSQL connections in the pool. |
| `SPEICHER_ASSET_PATH` | `./var/assets` | web + worker | Upload directory. Must be writable by the process. |
| `SPEICHER_MIRROR_ROOT` | `./var/mirrors` | worker | Directory into which a sync downloads the data from git. The data is removed after each sync. Must be writable. |
| `SPEICHER_SYNC_CONCURRENCY` | `4` | worker | Maximum number of repositories to sync at once. |
| `SPEICHER_RECONCILE_INTERVAL` | `15m` | worker | Interval between remote checks for tracked repositories (e.g. `15m`). Shorter intervals increase load. |
| `SPEICHER_DISCOVER_INTERVAL` | `6h` | worker | Interval between forge scans for new repositories (e.g. `6h`). Tracked repositories use `SPEICHER_RECONCILE_INTERVAL` instead. |
| `SPEICHER_PUBLIC_URL` | — | web + worker | Public instance URL for webhooks, magic links, and the sitemap. Uses the request host if unset. |
| `SPEICHER_ANON_RATE_LIMIT` | `60` | web | Anonymous requests allowed per minute per client IP. Signed-in users are exempt. Use `0` for no limit. |
| `SPEICHER_PUBLIC_MAX_AGE` | `60` | web | Cache-Control `max-age` for anonymous responses, in seconds. Use `0` to disable public caching. |
| `SPEICHER_TRUST_PROXY` | `loopback` | web | Trusted proxies for client IP and protocol: comma-separated `loopback`, `linklocal`, `uniquelocal`, IPs, or subnets. Use `uniquelocal` in Docker. No `true` or hop counts. |
| `SPEICHER_LOG_LEVEL` | `info` | web + worker | Minimum log level: `debug`, `info`, `warn`, or `error`. SQL queries appear only at `debug`. |
| `SPEICHER_LOG_FORMAT` | `json` | web + worker | Log format: `json` for one JSON object per line, or `pretty` for aligned, coloured text. |
| `SPEICHER_DEV_LOGIN` | `false` | web | Enable sign-in as any identity without authentication. Development only; never enable in production. |
| `SPEICHER_INSECURE_COOKIES` | `false` | web | Remove the Secure cookie flag to allow cookies over HTTP. Development only; never enable in production. |
| `PORT` | `3000` | web | HTTP server TCP port. |
<!-- prettier-ignore-end -->
<!-- /generated -->

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
