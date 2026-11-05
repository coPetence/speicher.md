---
icon: server
title: Manual Setup Self-hosting
---

# Self-hosting with Docker Compose (Manual Setup)

## Prerequisites

- **Docker** with the **Compose plugin**. [How to install](https://docs.docker.com/engine/install/)
- **Port 32168** is not in use on your machine. If it is taken, do [use a different port](../06-reference/08-troubleshooting.md#port-32168-already-in-use)

## 1. Create the compose file

Create a directory for the instance, for example `speicher/`, and save the following as `docker-compose.yaml` inside it:

```yaml
x-speicher: &speicher
  image: ghcr.io/copetence/speicher.md:latest
  environment:
    SPEICHER_DATABASE_URL: postgres://speicher:${POSTGRES_PASSWORD}@db:5432/speicher
    SPEICHER_PUBLIC_URL: http://localhost:32168
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
      - '32168:3000'
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

Open [http://localhost:32168](http://localhost:32168), or the address of your server.

## 4. Claim the instance

The claim page shows a code, such as `GRANTIG-DACKEL-4015`. To approve it, run this in the directory of your `docker-compose.yaml`, with your code:

```sh
docker compose exec web speicher claim <YOUR-CODE>
```

Within a few seconds, the browser opens the setup page.

:::note
The claimed browser is a temporary administrator. It can configure the instance until you [become the first administrator](02-setup-instance.md#4-become-the-first-administrator). After that, the instance can no longer be claimed.
:::

**[Continue with setting up the instance →](02-setup-instance.md)**
