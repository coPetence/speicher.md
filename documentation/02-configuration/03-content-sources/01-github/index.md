---
icon: folder-git-2
---

# GitHub as a content source

Speicher reads repositories on GitHub through a GitHub App. The App gives Speicher read access to the repositories you install it on, and tells Speicher about every push, so pages update shortly after a change.

## 0. Before you start

- Speicher must be reachable from GitHub for webhooks to work. Set [`SPEICHER_PUBLIC_URL`](../../../06-reference/02-environment-variables.md) to the public address of your instance first. GitHub does not accept a webhook on `localhost`; an App created there has no webhook, and Speicher picks up changes on its regular schedule instead (see [step 4](#4-how-repositories-are-synced)).
- Decide where the App lives. Create it under the **organization** that owns your documentation repositories. An App created under a personal account can only be installed on that account's repositories, unless you make it public.

## 1. Add a GitHub source in Speicher

In the dashboard, go to **Configuration → Content sources**, choose **Add a source** and select **GitHub App**. Give the source a short id, for example `github`.

If you use GitHub Enterprise Server, enter its address as **Base URL**, for example `https://github.example.com`. Leave it empty for GitHub.com.

## 2. Create the GitHub App

There are two ways to create the App.

### Let Speicher create it (recommended)

Choose **Create on GitHub**, enter the organization the App should belong to (leave it empty for your personal account), and continue. GitHub shows you the App with everything filled in: its name, permissions, webhook URL and events. Confirm it there.

GitHub then sends you back to Speicher, which saves the App's id, private key and webhook secret, and forwards you to the App's installation page on GitHub. Continue with [step 3](#3-install-the-app).

<!-- screenshot: the "Create on GitHub" choice on a new GitHub source -->

### Create it manually

Choose **Enter manually**. In GitHub, go to **Organization Settings → Developer settings → GitHub Apps → New GitHub App** and fill in:

- **Homepage URL**: the address of your Speicher instance.
- **Webhook URL**: the URL Speicher shows under **Webhook URL**. It has the form `https://<your-host>/-/hooks/forge/<source-id>`.
- **Webhook secret**: a long random string. You enter the same value in Speicher.
- **Repository permissions**:

  | Permission    | Access         | Used for                                               |
  | ------------- | -------------- | ------------------------------------------------------ |
  | Contents      | Read-only      | Cloning the repository                                 |
  | Metadata      | Read-only      | Listing repositories (GitHub requires it)              |
  | Pull requests | Read-only      | Checking `.speicher.yaml` in pull requests             |
  | Checks        | Read and write | Reporting the result of that check on the pull request |

- **Subscribe to events**: **Push**, **Pull request** and **Repository**.

Create the App, then generate a private key at the bottom of its settings page. GitHub downloads it as a `.pem` file.

Back in Speicher, enter:

- **App id**: shown at the top of the App's settings page.
- **Private key**: paste the content of the `.pem` file, or drop the file onto the field.
- **Webhook secret**: the secret you entered on GitHub.

Save the configuration.

:::note
Without a webhook secret, Speicher rejects every webhook delivery and only notices changes on its regular schedule.
:::

## 3. Install the App

On the App's page on GitHub, choose **Install** and select the account or organization. You can give it access to all repositories, or only to selected ones. Speicher can only see the repositories the App is installed on.

Only repositories with a `.speicher.yaml` at their root are published. The others are skipped, so installing the App on all repositories publishes nothing by itself. See [Publish your first repository](../../../01-quick-start/03-setup-repository.md) for the file.

<!-- screenshot: the installation page on GitHub with "Only select repositories" -->

## 4. How repositories are synced

- **New repositories**: when you install the App or add a repository to its installation, GitHub notifies Speicher and the repository is picked up right away. Speicher also looks for new repositories every 6 hours (`SPEICHER_DISCOVER_INTERVAL`).
- **Changes**: a push to the repository's default branch triggers a sync. Pushes to other branches are ignored. In addition, Speicher checks every repository against GitHub every 15 minutes (`SPEICHER_RECONCILE_INTERVAL`), which catches anything a missed webhook left out.
- **Pull requests**: when a pull request is opened or updated, Speicher checks the `.speicher.yaml` files it contains and reports the result as a check named `speicher` on the pull request.
- **Renamed repositories** are followed. Repositories that are deleted, archived or transferred, or that are removed from the App's installation, are taken offline.

To sync a repository immediately, run:

```sh
docker compose exec web speicher sync-repo-content <owner>/<repository>
```

and to look for new repositories immediately, `speicher sync-repo-list <source-id>`.

## 5. Choose the URLs

A repository is served at `/<owner>/<repository>`, for example `https://github.com/acme/handbook` at `https://<your-host>/acme/handbook`. Under **Simpler URLs** you can shorten this:

- **Default repository owner**: the account or organization whose name is left out. With `acme`, the handbook is served at `/handbook`. Repositories of other owners keep `/<owner>/<repository>`.
- **Primary**: the primary source leaves its own id out of the URL. Only one source can be primary. When there is only one source, it is the primary one. Every other source puts its id in front: `/<source-id>/<owner>/<repository>`.

<!-- screenshot: the "Simpler URLs" card -->

## Configuration file

If you keep your configuration in a file instead of the database, a GitHub source looks like this:

```yaml
forges:
  github:
    type: github
    app_id: '123456'
    private_key: ${GITHUB_APP_PRIVATE_KEY}
    webhook_secret: ${GITHUB_WEBHOOK_SECRET}
    default_repository_owner: acme
```

## Settings

<!-- generated: schema instance#/$defs/forge forges.<id> -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `forges.<id>` | object |  |  |  |
| `forges.<id>.type` | `github`, `gitlab`, `gitea`, `forgejo`, `git` |  | yes | The kind of source. `github` reads repositories through a GitHub App; `git` reads repositories you list from any git server over HTTPS or SSH. |
| `forges.<id>.primary` | boolean | `false` |  | Whether this source's id is left out of its repositories' URLs. Only one source can be primary; when there is only one source, it is primary. Repositories of other sources are served under `/<source-id>/…`. |
| `forges.<id>.default_repository_owner` | string |  |  | The user or organization whose name is left out of the URL, so its repositories are served at `/<repo>` instead of `/<owner>/<repo>`. Repositories of other owners keep the owner in their URL. |
| `forges.<id>.base_url` | string (uri) |  |  | GitHub only. The address of your GitHub Enterprise Server, for example `https://github.example.com`. Leave it empty for GitHub.com. |
| `forges.<id>.webhook_secret` | string |  | if `type` is `gitlab`, `gitea`, `forgejo` | GitHub only. The secret of the GitHub App's webhook. Without it, Speicher rejects webhook deliveries and picks up changes only on its regular schedule. |
| `forges.<id>.app_id` | string |  | if `type: github` | GitHub only. The id of the GitHub App, shown at the top of the App's settings page. |
| `forges.<id>.private_key` | string |  | if `type: github` | GitHub only. The private key of the GitHub App, the content of the `.pem` file GitHub generates. |
| `forges.<id>.token` | string |  | if `type` is `gitlab`, `gitea`, `forgejo` | gitlab / gitea / forgejo |
| `forges.<id>.poll_interval` | string | `1h` |  | Git only. How often Speicher checks each repository of this source for new commits, for example `15m`. Repositories can override it. |
| `forges.<id>.known_hosts` | string |  |  | Git only. The SSH host keys of the servers the `ssh://` repositories are fetched from, as `known_hosts` lines. Required as soon as one repository uses an `ssh://` URL; Speicher connects only to servers listed here. |
| `forges.<id>.repos` | list of object |  | if `type: git` | Git only. The repositories this source serves. They are listed here because a plain git server cannot be asked for them. |
| `forges.<id>.repos[].id` | string |  | yes | Identifies the repository within this source. Choose it once and keep it: Speicher uses it to recognize the repository when its URL or slug changes. |
| `forges.<id>.repos[].url` | string |  | yes | The remote URL: `https://host/owner/repo.git` with a `token`, or `ssh://user@host/owner/repo.git` with a `deploy_key`. `http://` and `git://` URLs are refused. |
| `forges.<id>.repos[].slug` | string |  |  | The repository's name in URLs. Defaults to `id`. If you change it, the old URLs redirect to the new ones. |
| `forges.<id>.repos[].branch` | string |  |  | The branch to publish. Defaults to the repository's default branch. |
| `forges.<id>.repos[].deploy_key` | string |  |  | SSH only. The private key of a read-only deploy key, without a passphrase. Required for `ssh://` URLs. |
| `forges.<id>.repos[].token` | string |  |  | HTTPS only. An access token that can read the repository. Required for every `https://` URL, also for public repositories. |
| `forges.<id>.repos[].username` | string | `x-access-token` |  | HTTPS only. The username that goes with the token. It differs between hosts, for example `oauth2` on GitLab. |
| `forges.<id>.repos[].poll_interval` | string |  |  | Overrides the forge-level interval for this repository. |
<!-- prettier-ignore-end -->
<!-- /generated -->
