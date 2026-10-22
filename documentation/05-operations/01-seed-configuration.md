---
icon: sprout
---

# Seed the configuration from a file

Instead of claiming the instance and configuring it in the browser, you can start it with a ready-made `speicher.instance.yaml`. This is useful when you set up instances from scripts, or want the same starting configuration for several instances.

## How seeding works

When Speicher starts and its database holds no configuration yet, it reads the file at `SPEICHER_CONFIG` and stores it as configuration version 1. The web process logs:

```
web-1  | {"level":"info","ctx":"config","msg":"adopted the config file as instance config version 1","path":"/etc/speicher/speicher.instance.yaml"}
```

From then on, the database holds the configuration and the file is no longer read:

- Change the configuration in the dashboard under `/-/config`. Editing the file has no effect.
- If the file is missing, Speicher serves the claim page as usual.
- If the file is invalid, for example because of a typo in a key or an unset `${VAR}`, Speicher stores nothing and reports the error.

:::note
This is different from `SPEICHER_CONFIG_SOURCE=file`, where the file stays the configuration for good. It is then read-only in the dashboard, and you restart Speicher to apply changes.
:::

## 1. Write the file

Put a `speicher.instance.yaml` next to your `compose.yml`. A minimal file needs an identity provider and an administrator:

```yaml
version: 1

auth:
  providers:
    company:
      type: oidc
      display_name: Company SSO
      issuer: https://login.example.com/realms/staff
      client_id: speicher
      client_secret: ${OIDC_CLIENT_SECRET}

groups:
  staff:
    - provider: company
      id: staff

admins:
  users:
    - email: you@example.com
```

- Register Speicher with your provider first, as its guide in [Set up the instance](../01-quick-start/02-setup-instance.md#2-add-an-identity-provider) explains.
- `groups` is optional here, but repositories grant access to these names, so it's convenient to define them now.
- Every other key is listed in the [instance configuration reference](../06-reference/03-instance-configuration.md).

Keep secrets out of the file and reference them as `${VAR}` instead. The stored configuration keeps the reference, not the value, so the variable must stay set on every start.

## 2. Mount it into the containers

Add the file, its path and the secrets to the shared block of your `compose.yml`:

```yaml
x-speicher: &speicher
  image: ghcr.io/copetence/speicher.md:latest
  environment:
    SPEICHER_DATABASE_URL: postgres://speicher:${POSTGRES_PASSWORD}@db:5432/speicher
    SPEICHER_PUBLIC_URL: http://localhost:3000
    SPEICHER_CONFIG: /etc/speicher/speicher.instance.yaml
    OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET}
  volumes:
    - speicher-data:/var/lib/speicher
    - ./speicher.instance.yaml:/etc/speicher/speicher.instance.yaml:ro
  restart: unless-stopped
```

Add the secret to your `.env` file:

```sh
OIDC_CLIENT_SECRET=<the client secret from your provider>
```

## 3. Start the instance

```sh
docker compose up -d
docker compose logs -f web worker
```

Look for the `adopted the config file` line. Because the file names an administrator, there is no claim page. Open the instance, sign in as that administrator, and the dashboard is under `/-/`.

## Seeding again

Speicher seeds only into an empty database. To start over from the file, remove the database volume, which deletes everything the instance has stored:

```sh
docker compose down
docker volume rm <project>_speicher-db
docker compose up -d
```
