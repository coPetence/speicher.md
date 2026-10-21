# Self-hosting with Docker Compose

Speicher runs as two processes from the same container image:

- **web** serves your documentation, the dashboard and the MCP server.
- **worker** syncs your repositories and builds the search index.

Both use one PostgreSQL database with the `pgvector` extension, and share one volume for the git mirrors and asset files.

## 1. Create the compose file

Create a directory for the instance, for example `speicher/`, and put this `compose.yml` in it:

```yaml
x-speicher: &speicher
  image: ghcr.io/copetence/speicher.md:latest
  environment:
    SPEICHER_DATABASE_URL: postgres://speicher:${POSTGRES_PASSWORD}@db:5432/speicher
    SPEICHER_PUBLIC_URL: http://localhost:3000
  volumes:
    - speicher-data:/var/lib/speicher
  restart: unless-stopped

services:
  db:
    image: pgvector/pgvector:pg17
    environment:
      POSTGRES_USER: speicher
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: speicher
    volumes:
      - speicher-db:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U speicher -d speicher']
      interval: 2s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  # Applies database migrations, then exits. Web and worker wait for it.
  migrate:
    <<: *speicher
    command: ['speicher', 'migrate', 'up']
    restart: 'no'
    depends_on:
      db:
        condition: service_healthy

  web:
    <<: *speicher
    ports:
      - '3000:3000'
    depends_on:
      migrate:
        condition: service_completed_successfully

  worker:
    <<: *speicher
    command: ['node', 'dist/worker.js']
    depends_on:
      migrate:
        condition: service_completed_successfully

volumes:
  speicher-db:
  speicher-data:
```

Next to it, create a `.env` file with a password for the database:

```sh
POSTGRES_PASSWORD=<a long random password>
```

:::note
Web and worker refuse to start while database migrations are pending. That is why the `migrate` service runs first, on every start. When nothing is pending, it exits right away.
:::

## 2. Start the instance

```sh
docker compose up -d
docker compose logs -f web worker
```

Wait until the web process logs that it is listening:

```
web-1  | {"level":"warn","ctx":"config","msg":"no instance configuration; serving the claim page","source":"database"}
web-1  | {"level":"info","ctx":"main","msg":"listening","port":3000}
```

The first line is expected. A new instance has no configuration yet, and you create it in the browser in the next step.

## 3. Open it in your browser

Open [http://localhost:3000](http://localhost:3000). You will see the claim page, which is where you [set up the instance](02-setup-instance.md).

## Running on a server

The compose file above is enough to try Speicher on your own machine. On a server that others use, change the following:

- **Serve it over HTTPS.** Put a reverse proxy with TLS in front of the web service. Speicher sets its cookies as `Secure`, so browsers refuse to sign in over plain HTTP on any host other than `localhost`.
- **Set `SPEICHER_PUBLIC_URL`** to the address people use, for example `https://docs.example.com`. Magic links, webhook deliveries and the sitemap use it.
- **Set `SPEICHER_TRUST_PROXY` to `uniquelocal`.** Without it, Speicher sees every request as coming from the proxy over HTTP. Sign-in callbacks then point to the wrong address, and rate limiting counts all visitors as one.
- **Bind the port to the proxy only**, for example `'127.0.0.1:3000:3000'` when the proxy runs on the same host.

[Reverse proxy and TLS](../05-operations/04-reverse-proxy-and-tls.md) has complete, tested setups for Caddy and nginx.

<!-- generated: env-vars SPEICHER_DATABASE_URL,SPEICHER_PUBLIC_URL,SPEICHER_TRUST_PROXY,PORT -->
<!-- prettier-ignore-start -->
| Variable | Default | Read by | Description |
| -------- | ------- | ------- | ----------- |
| `SPEICHER_DATABASE_URL` | `postgres://speicher:speicher@127.0.0.1:55432/speicher` | web + worker | PostgreSQL connection string. The database must be reachable at boot; a missing or refused connection prevents startup. |
| `SPEICHER_PUBLIC_URL` | — | web + worker | The public URL of this instance, used in webhook deliveries, magic links, and the sitemap. When unset, the request host is used instead. |
| `SPEICHER_TRUST_PROXY` | `loopback` | web | Which proxies to believe about the client address and protocol: `loopback`, `linklocal`, `uniquelocal`, IP addresses or subnets, comma-separated. In Docker, set `uniquelocal`; `true` and hop counts are not accepted. |
| `PORT` | `3000` | web | TCP port the HTTP server listens on. |
<!-- prettier-ignore-end -->
<!-- /generated -->

Every other setting is listed under [Environment variables](../06-reference/02-environment-variables.md).

## Updating

Pull the new image and start again. The `migrate` service applies any new migrations before web and worker start.

```sh
docker compose pull
docker compose up -d
```
