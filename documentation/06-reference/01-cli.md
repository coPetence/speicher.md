---
icon: terminal
---

# CLI

The `speicher` command manages an instance from its host. In a Docker Compose deployment, run it inside the web container:

```sh
docker compose exec web speicher <command> [options]
```

`speicher help` lists every command.

<!-- generated: cli without:reembed -->
<!-- prettier-ignore-start -->
## migrate

```sh
speicher migrate [up|down|status]
```

Manage database migrations: up applies pending migrations (default), down reverts the last, status lists pending migrations.

## rebuild

```sh
speicher rebuild [--purge]
```

Queue a rebuild of all repository pages from their current commits, even if unchanged. --purge deletes stored content first but keeps search embeddings. A worker runs the rebuild.

## claim

```sh
speicher claim [<code>]
```

Approve a browser to set up this instance, or omit the code to list waiting browsers. Codes expire after one hour.

## reopen-claim-window

```sh
speicher reopen-claim-window
```

Reopen the claim window when no administrator is configured. If an existing administrator cannot sign in, use `speicher admin add` instead.

## jobs

```sh
speicher jobs list [--status <status>] [--limit <number>] | retry (<id> | --all | --kind <kind>)
```

List queued jobs or retry dead jobs.

## sync-repo-list

```sh
speicher sync-repo-list [<forge>]
```

Queue a repository list sync for one forge or all configured forges. Adds new repositories, updates renamed ones, and removes missing ones. Does not wait for completion.

## sync-repo-content

```sh
speicher sync-repo-content <namespace>/<slug> [--force]
```

Queue a sync of a repository’s latest commit to rebuild pages, assets and search data. Unchanged commits are skipped unless --force is set. Use <namespace>/<slug>, or <slug> if unique. A worker runs the sync.

## repos

```sh
speicher repos list
```

List registered repositories.

## forges

```sh
speicher forges list
```

List configured forges.

## config

```sh
speicher config export [<path>] [--with-secrets]
```

Export configuration to a new file or stdout. Existing files are not overwritten. Secrets become environment variable references unless --with-secrets is used.

## admin

```sh
speicher admin add (--email <address> | --subject <id> --note <text>) [--provider <id>]
```

Add an administrator by email or identity-provider subject ID. Requires a stored configuration; otherwise, open the instance in a browser to claim it.
<!-- prettier-ignore-end -->
<!-- /generated -->
