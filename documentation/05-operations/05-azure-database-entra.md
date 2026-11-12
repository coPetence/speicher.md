---
icon: database
---

# Azure Database for PostgreSQL with Entra sign-in

speicher.md can sign in to Azure Database for PostgreSQL with a Microsoft Entra token instead of a password.

## Before you start

- The server has Microsoft Entra authentication enabled, and you can sign in as its Entra administrator.
- speicher.md runs with two identities, each a managed identity or a workload identity federated to an AKS service account:
  - database migration job (DDL rights)
  - web and worker processes (read and write)

The running application never changes the database schema, so its identity needs no more than read and write access.

## 1. Allow the extensions

In the server parameters, add `UNACCENT`, `PG_TRGM` and `VECTOR` to `azure.extensions`.

## 2. Create the database roles

Replace `<migrator-identity>` and `<app-identity>` with the names of the identities in Entra (e.g. names of the user-assigned managed identities).

Connect to the `postgres` database as the Entra administrator and create one role per identity:

```sql
SELECT * FROM pgaadauth_create_principal('<migrator-identity>', false, false);
SELECT * FROM pgaadauth_create_principal('<app-identity>', false, false);
```

Then create the database and give both roles their access.

```sql
CREATE DATABASE speicher;

\c speicher

-- Only the administrator can create the vector extension
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- The migrator creates and changes the tables
GRANT ALL ON SCHEMA public TO "<migrator-identity>";

-- The application reads and writes every table in the schema
GRANT USAGE ON SCHEMA public TO "<app-identity>";
ALTER DEFAULT PRIVILEGES FOR ROLE "<migrator-identity>" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "<app-identity>";
ALTER DEFAULT PRIVILEGES FOR ROLE "<migrator-identity>" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO "<app-identity>";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "<app-identity>";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "<app-identity>";
```

## 3. Configure speicher.md

Put the role name in the URL as the user, leave the password out, and require TLS. The `speicher migrate` job signs in as the migrator:

```yaml
SPEICHER_DATABASE_URL: postgres://<migrator-identity>@example.postgres.database.azure.com:5432/speicher?sslmode=verify-full
SPEICHER_DATABASE_AUTH: managed_identity
SPEICHER_DATABASE_CLIENT_ID: <migrator-client-id>
```

The web and worker processes sign in as the application:

```yaml
SPEICHER_DATABASE_URL: postgres://<app-identity>@example.postgres.database.azure.com:5432/speicher?sslmode=verify-full
SPEICHER_DATABASE_AUTH: managed_identity
SPEICHER_DATABASE_CLIENT_ID: <app-client-id>
```

Web and worker do not migrate the database.

`SPEICHER_DATABASE_AUTH` selects how speicher.md signs in to the database:

- **`managed_identity`** is the identity of the host: a VM, Container App, Container Apps job or App Service. Set `SPEICHER_DATABASE_CLIENT_ID` to the client ID of a user-assigned identity; leave it unset for the system-assigned one.
- **`workload_identity`** is the federated token an AKS pod is given. The client ID and tenant come from `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`, which the workload identity webhook sets; `SPEICHER_DATABASE_CLIENT_ID` overrides the client ID.
