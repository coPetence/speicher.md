---
icon: server
---

# Self-hosting with Docker Compose

Speicher runs as two processes from the same container image:

- **web** serves documentation, dashboard and MCP server
- **worker** syncs repositories and builds the search index

## Prerequisites

- **Docker** with the **Compose plugin**. [How to install](https://docs.docker.com/engine/install/)
- **Port 3000** is not in use on your machine. If it is taken, do [use a different port](../reference/troubleshooting#port-3000-already-in-use)

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

Generate a database password and write it to a `.env` file next to the docker compose file:

```sh
if ! grep -q '^POSTGRES_PASSWORD=' .env 2>/dev/null; then
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
  chmod 600 .env
fi
```

**[If NOT on localhost continue to setup HTTPS →](../05-operations/04-reverse-proxy-and-tls.md)**

## 2. Start the instance

```sh
docker compose up -d
```

## 3. Open it in your browser

Open [http://localhost:3000](http://localhost:3000), or the address of your server.

**[Continue with setting up the instance →](02-setup-instance.md)**
