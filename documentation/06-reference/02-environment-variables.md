---
icon: variable
---

# Environment variables

Environment variables configure how the processes run: where the database and storage are, how often the worker syncs, and how the web server sits behind a proxy. Everything else lives in the [instance configuration](03-instance-configuration.md).

A `SPEICHER_*` variable that is set but not listed here stops the process from starting, so a misspelled name is caught at boot.

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
