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

Applies or reverts database migrations. down reverts the last migration, up applies all pending migrations, status shows pending migrations.

## rebuild

```sh
speicher rebuild [--purge]
```

Rebuilds the pages of every repository from its current commit, even if the commit has not changed. With `--purge`, it deletes the stored content first but keeps the search embeddings. The command only queues the work, and the worker carries it out.

## claim

```sh
speicher claim [<code>]
```

Approves a browser that is waiting to set up this instance. If you run the command without a code, it lists the browsers that are waiting. A code expires after an hour.

## reopen-claim-window

```sh
speicher reopen-claim-window
```

Reopens the claim window. This could be needed if the claim window was closed and no administrator is configured, for example after a configuration rollback. If an administrator is still configured but cannot sign in, run `speicher admin add` instead.

## jobs

```sh
speicher jobs list [--status <status>] [--limit <number>] | retry (<id> | --all | --kind <kind>)
```

Lists the jobs in the queue or puts dead jobs back on it. To see the queued jobs, run `speicher jobs list`. To put a dead job back on the queue, run `speicher jobs retry <id>`.

## sync-repo-list

```sh
speicher sync-repo-list [<forge>]
```

Fetches the list of repositories from the provided forge or all configured forges if none was provided. It then updates the list of repositories in the database to match the fetched list. New repositories are added, renamed ones are updated, and repositories that are no longer present are removed. This command only queues the job, it does not await its completion.

## sync-repo-content

```sh
speicher sync-repo-content <namespace>/<slug> [--force]
```

Fetches the newest commit of one repository and rebuilds its pages, assets and search data from it. If the commit has not changed since the last successful sync, nothing is rebuilt. With `--force`, the command rebuilds the repository even if the commit has not changed. You name the repository as `<namespace>/<slug>`, or as `<slug>` alone if no other namespace uses it. The command only queues the work, and the worker carries it out.

## repos

```sh
speicher repos list
```

List every repository registered on this instance.

## forges

```sh
speicher forges list
```

List every content source configured on this instance.

## config

```sh
speicher config export [<path>] [--with-secrets]
```

Writes the instance configuration to the given file, or to stdout if you give no path. An existing file is never overwritten. Secrets stored in the configuration are replaced by environment variable references, unless you add --with-secrets.

## admin

```sh
speicher admin add (--email <address> | --subject <id> --note <text>) [--provider <id>]
```

Adds an administrator to the stored configuration, identified by an email address or by the subject claim of their identity provider. This requires a stored configuration. If no configuration is stored yet, open the instance in a browser and claim it there instead.
<!-- prettier-ignore-end -->
<!-- /generated -->
