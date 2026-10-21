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
| `SPEICHER_TRUST_PROXY` | `loopback` | web | Which proxies to believe about the client address and protocol: `loopback`, `linklocal`, `uniquelocal`, IP addresses or subnets, comma-separated. In Docker, set `uniquelocal`; `true` and hop counts are not accepted. |
| `SPEICHER_LOG_LEVEL` | `info` | web + worker | Minimum log level to emit: `debug`, `info`, `warn`, or `error`. SQL queries are logged only at `debug` level. |
| `SPEICHER_LOG_FORMAT` | `json` | web + worker | The log format decides how each log line is written: `json` writes one JSON object per line, and `pretty` writes an aligned, coloured line. |
| `SPEICHER_DEV_LOGIN` | `false` | web | Show a development sign-in form that issues a session for any typed identity, without authentication. Never enable in production. |
| `SPEICHER_INSECURE_COOKIES` | `false` | web | Omit the Secure flag on cookies, allowing them over HTTP. Never enable in production; without this flag, modern browsers refuse cookies over plain HTTP. |
| `PORT` | `3000` | web | TCP port the HTTP server listens on. |
<!-- prettier-ignore-end -->
<!-- /generated -->
