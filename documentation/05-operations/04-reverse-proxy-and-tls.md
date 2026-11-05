---
icon: network
---

# Reverse proxy and TLS

Speicher serves plain HTTP on port 3000 inside its container; the quick start publishes it on port 32168 of the host. This page sets up a proxy, to serve HTTPS, for the Docker Compose file from the [quick start guide](../01-quick-start/01-self-hosted.md). There are two options to set up the proxy:

- [Caddy in the Compose file](#caddy-in-the-compose-file) gets and renews certificates by itself. Use it if you do not plan to run any other services on the same server.
- [nginx on the host](#nginx-on-the-host), if you already run nginx there or want to use it for other services as well.

## Before you start

- Choose the domain for Speicher, for example `docs.example.com`, and point its DNS record at the server. In every step below, replace `docs.example.com` with your domain.
- Open ports 80 and 443 on the server.

## 1. Set the public URL and the trusted proxy

In `docker-compose.yaml`, under `environment:` in the `x-speicher` block, set your domain as the public URL and add the trusted proxy:

```yaml
SPEICHER_PUBLIC_URL: https://docs.example.com
SPEICHER_TRUST_PROXY: uniquelocal
```

Write the URL without a path or a trailing slash.

Speicher takes the client IP from `X-Forwarded-For` and the protocol from `X-Forwarded-Proto` only when the request comes from a trusted address. The proxy connects from a private IPv4 address: Caddy from its address on the Docker network, nginx on the host from the gateway of the Docker bridge. By setting `SPEICHER_TRUST_PROXY` to `uniquelocal` we trust all private IP addresses. For other values of `SPEICHER_TRUST_PROXY`, see [Trusted proxies](#trusted-proxies).

## 2. Set up the proxy

### Caddy in the Compose file

1. In the `web` service, remove `ports`, so only Caddy can reach Speicher.

2. Add the Caddy service and its volumes to `docker-compose.yaml`, next to the existing ones:

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

3. Create a `Caddyfile` next to `docker-compose.yaml`, with your domain in the first line:

   ```
   <YOUR DOMAIN> {
   	reverse_proxy web:3000
   }
   ```

   Replace `<YOUR DOMAIN>` with your domain, for example `docs.example.com`. Caddy will request a certificate from Let's Encrypt on the first start.

4. Start the containers:

   ```sh
   docker compose up -d
   ```

**[Continue with setting up the instance →](../01-quick-start/02-setup-instance.md)**

---

### nginx on the host

1. In the `web` service, publish the port on `127.0.0.1` only, so nothing but nginx can reach Speicher:

   ```yaml
   ports:
     - '127.0.0.1:32168:3000'
   ```

2. Get a certificate for your domain, for example with Certbot.

3. Add a site to nginx. Replace `docs.example.com` with your domain, and the certificate paths with the ones your certificate tool created:

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
           proxy_pass http://127.0.0.1:32168;
           proxy_set_header Host              $host;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

4. Reload nginx and start Speicher:

   ```sh
   sudo nginx -t && sudo systemctl reload nginx
   docker compose up -d
   ```

### Other proxies

Any reverse proxy works if it:

- serves HTTPS and forwards to Speicher over HTTP
- sends `X-Forwarded-For` and `X-Forwarded-Proto`, and passes on the original `Host` header
- is the only thing that can reach Speicher's port

Speicher uses no WebSockets or long-lived connections, so the proxy needs no special timeouts.

## 3. Check that it works

1. To check that Speicher answers over HTTPS, run:

   ```sh
   curl https://docs.example.com/-/readyz
   ```

   It answers with `{"status":"ready",…}` once Speicher can serve requests.

2. To check that Speicher uses your public URL, run:

   ```sh
   curl https://docs.example.com/.well-known/oauth-authorization-server
   ```

   The `issuer` in the answer must be your public URL.

If you use the [GitHub App](../02-configuration/03-content-sources/01-github/index.md) content source, GitHub must also reach the instance from the internet to deliver webhooks.

**[Continue with setting up the instance →](../01-quick-start/02-setup-instance.md)**

## Trusted proxies

`SPEICHER_TRUST_PROXY` lists the addresses from which Speicher accepts the `X-Forwarded-For` and `X-Forwarded-Proto` headers. Give one or more of these values, separated by commas:

| Value                   | Trusts                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `uniquelocal`           | private network addresses: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `fc00::/7`. Use it with Docker. |
| `loopback` (default)    | `127.0.0.1` and `::1`, for a proxy on the same host when Speicher does not run in Docker                       |
| `linklocal`             | `169.254.0.0/16` and `fe80::/10`                                                                               |
| an IP address or subnet | that address only, for example the proxy's Docker network `172.18.0.0/16`                                      |

In Docker, requests reach Speicher from a private Docker network address, even when the proxy runs on the same host, so the default `loopback` does not work there. With `uniquelocal`, make sure only the proxy can reach Speicher's port, as both setups above do. Otherwise anyone on your network could send forged headers.

## Settings

<!-- generated: env-vars SPEICHER_PUBLIC_URL,SPEICHER_TRUST_PROXY,SPEICHER_INSECURE_COOKIES,PORT -->
<!-- prettier-ignore-start -->
| Variable | Default | Read by | Description |
| -------- | ------- | ------- | ----------- |
| `SPEICHER_PUBLIC_URL` | — | web + worker | Public instance URL for webhooks, magic links, and the sitemap. Uses the request host if unset. |
| `SPEICHER_TRUST_PROXY` | `loopback` | web | Trusted proxies for client IP and protocol: comma-separated `loopback`, `linklocal`, `uniquelocal`, IPs, or subnets. Use `uniquelocal` in Docker. No `true` or hop counts. |
| `SPEICHER_INSECURE_COOKIES` | `false` | web | Remove the Secure cookie flag to allow cookies over HTTP. Development only; never enable in production. |
| `PORT` | `3000` | web | HTTP server TCP port. |
<!-- prettier-ignore-end -->
<!-- /generated -->
