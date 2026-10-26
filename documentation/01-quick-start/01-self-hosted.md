---
icon: server
---

# Self-hosting with Docker Compose

Speicher runs as two processes from the same container image:

- **web** serves your documentation, the dashboard and the MCP server.
- **worker** syncs your repositories and builds the search index.

Both use one PostgreSQL database with the `pgvector` extension, and share one volume for the git mirrors and asset files.

## Prerequisites

- **Docker** with the **Compose plugin**. Install Docker Engine and the `docker-compose-plugin` package. To check that both are installed, run `docker compose version`.
- **Port 3000** is free on your machine. If it is taken, change the port mapping of the `web` service in the compose file.

## 1. Create the compose file

Create a directory for the instance, for example `speicher/`, and save the following as `docker-compose.yaml` inside it:

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

  # Applies database migrations on every start, then exits. Web and worker wait for it.
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
POSTGRES_PASSWORD=<password>
```

To generate a password and write the `.env` file in one step, run this command in the directory:

```sh
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" > .env
```

**On a server**, Speicher must be served over HTTPS. This is a requirement since we use OIDC for authentication. Therefore if you plan to deploy Speicher on a server, make sure to set up a reverse proxy with TLS before proceeding. To do this follow the steps in [Reverse proxy and TLS](../05-operations/04-reverse-proxy-and-tls.md).

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

The first line is expected. A new instance has no configuration yet (unless you [seed it from a file](../05-operations/01-seed-configuration.md)). The second line indicates that the web server is running and listening on port 3000. You can now configure the instance in the browser.

## 3. Open it in your browser

Open [http://localhost:3000](http://localhost:3000), or the address of your server. You will see the claim page.

**[Continue with setting up the instance →](02-setup-instance.md)**

## Updating

Pull the new image and start the docker containers again. The `migrate` service applies any new migrations before web and worker start.

```sh
docker compose pull
docker compose up -d
```
