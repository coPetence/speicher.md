---
icon: network
---

# Reverse proxy and TLS

Speicher serves plain HTTP on port 3000 and expects a reverse proxy in front of it to handle HTTPS. This page shows two setups, both tested with the Docker Compose file from the [quick start](../01-quick-start/01-self-hosted.md):

- [Caddy in the Compose file](#caddy-in-the-compose-file), which gets and renews certificates by itself. Use it if nothing else runs on the server.
- [nginx on the host](#nginx-on-the-host), if you already run nginx there.

Whichever you use, Speicher needs the three settings below.

## What Speicher needs

**HTTPS.** Speicher marks its cookies as `Secure`, so browsers only send them back over HTTPS. Over plain HTTP, sign-in fails on every host except `localhost`.

**`SPEICHER_PUBLIC_URL`** set to the address people use, for example `https://docs.example.com`, with no path and no trailing slash. Speicher builds absolute links from it:

- sign-in callbacks and magic links
- the sign-in metadata that AI assistants read when they connect to the MCP server, which is not served at all without it
- the sitemap of public pages

The MCP server also refuses browser requests from any other origin.

**`SPEICHER_TRUST_PROXY`** set so that Speicher believes the `X-Forwarded-For` and `X-Forwarded-Proto` headers your proxy sends. Otherwise Speicher thinks every request came over plain HTTP from the proxy's address, and rate limiting counts all anonymous visitors as one.

In a Docker Compose setup, set it to `uniquelocal`:

```yaml
SPEICHER_TRUST_PROXY: uniquelocal
```

The default, `loopback`, does not work in Docker. Requests reach the container from a private Docker network address, never from `127.0.0.1`, even when the proxy runs on the same host.

`uniquelocal` trusts every private network address (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `fc00::/7`). Make sure only the proxy can reach port 3000, as both setups below do. Otherwise anyone on your network could send forged headers. You can also give the proxy's exact address or subnet, for example `172.18.0.0/16`, or several values separated by commas.

:::caution
Do not set `SPEICHER_TRUST_PROXY` to `true` or to a number of hops. Speicher passes the value on as a list of addresses, so `true` stops the web process from starting with `invalid IP address: true`, and a number is ignored.
:::

## Caddy in the Compose file

Caddy requests a certificate from Let's Encrypt and renews it by itself. Before you start, point your domain's DNS record at the server, and open ports 80 and 443.

Create a `Caddyfile` next to your `compose.yml`:

```
docs.example.com {
	reverse_proxy web:3000
}
```

Then change `compose.yml`:

1. Under `environment:` in the `x-speicher` block, set the public URL and trust the proxy:

   ```yaml
   SPEICHER_PUBLIC_URL: https://docs.example.com
   SPEICHER_TRUST_PROXY: uniquelocal
   ```

2. Remove the `ports` from the `web` service, so only Caddy can reach it.

3. Add the Caddy service and its volumes:

   ```yaml
   services:
     caddy:
       image: caddy:2
       ports:
         - '80:80'
         - '443:443'
         - '443:443/udp'
       volumes:
         - ./Caddyfile:/etc/caddy/Caddyfile:ro
         - caddy-data:/data
         - caddy-config:/config
       depends_on:
         - web
       restart: unless-stopped

   volumes:
     caddy-data:
     caddy-config:
   ```

   Keep the existing services and volumes; these are added to them. The `caddy-data` volume holds the certificates, so they survive a restart.

Start everything with `docker compose up -d`. Caddy forwards the client's address, the protocol and the original host by itself, so nothing else is needed.

## nginx on the host

If nginx runs directly on the server, change `compose.yml` in two places:

1. Under `environment:` in the `x-speicher` block, add the same two variables as for Caddy:

   ```yaml
   SPEICHER_PUBLIC_URL: https://docs.example.com
   SPEICHER_TRUST_PROXY: uniquelocal
   ```

2. In the `web` service, publish the port on `127.0.0.1` only, so nothing but nginx can reach it:

   ```yaml
   ports:
     - '127.0.0.1:3000:3000'
   ```

Then add a site to nginx. The certificate paths are examples; use the ones from your certificate tool, such as Certbot.

```nginx
server {
    listen 80;
    server_name docs.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name docs.example.com;

    ssl_certificate     /etc/letsencrypt/live/docs.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/docs.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

The three `proxy_set_header` lines are required. Without `X-Forwarded-Proto`, Speicher does not know the request came over HTTPS.

## Other proxies

Any reverse proxy works if it:

- terminates HTTPS and forwards to port 3000 over HTTP
- sends `X-Forwarded-For` and `X-Forwarded-Proto`, and passes on the original `Host` header
- is the only thing that can reach port 3000

Speicher uses no WebSockets or long-lived connections, so no special timeouts are needed. If your proxy sets an `X-Request-Id` header, Speicher uses it as the request id in its logs, so you can match proxy and Speicher log lines.

## Check that it works

1. Open `https://docs.example.com/-/readyz`. It answers `{"status":"ready",…}` once Speicher can serve requests.
2. Sign in. If the identity provider complains about the redirect URI, compare it with the callback URL `https://docs.example.com/api/auth/callback` (for GitHub sign-in, `https://docs.example.com/api/auth/github/callback`), and check `SPEICHER_PUBLIC_URL`.
3. Open `https://docs.example.com/.well-known/oauth-authorization-server`. The `issuer` must be your public URL. AI assistants read this when they connect.

If you use the [GitHub App](../02-configuration/03-content-sources/01-github/index.md) content source, GitHub must also be able to reach the instance from the internet to deliver webhooks.

## Settings

<!-- generated: env-vars SPEICHER_PUBLIC_URL,SPEICHER_TRUST_PROXY,SPEICHER_INSECURE_COOKIES,PORT -->
<!-- prettier-ignore-start -->
| Variable | Default | Read by | Description |
| -------- | ------- | ------- | ----------- |
| `SPEICHER_PUBLIC_URL` | — | web + worker | The public URL of this instance, used in webhook deliveries, magic links, and the sitemap. When unset, the request host is used instead. |
| `SPEICHER_TRUST_PROXY` | `loopback` | web | Which proxies to believe about the client address and protocol: `loopback`, `linklocal`, `uniquelocal`, IP addresses or subnets, comma-separated. In Docker, set `uniquelocal`; `true` and hop counts are not accepted. |
| `SPEICHER_INSECURE_COOKIES` | `false` | web | Omit the Secure flag on cookies, allowing them over HTTP. Never enable in production; without this flag, modern browsers refuse cookies over plain HTTP. |
| `PORT` | `3000` | web | TCP port the HTTP server listens on. |
<!-- prettier-ignore-end -->
<!-- /generated -->
