---
icon: folder-git-2
---

# Plain git remote as a content source

A plain git remote works with any git server: GitLab, Gitea, Forgejo, Bitbucket, or your own. speicher.md fetches each repository with git itself, so it needs no API of the host. In exchange, you list the repositories yourself, and speicher.md checks them for changes on a schedule instead of being notified.

For repositories on GitHub, [a GitHub App](../01-github/index.md) is the better choice: it finds repositories by itself and updates pages right after a push.

## 1. Add a plain git source in speicher.md

In the dashboard, go to **Configuration → Content sources**, choose **Add a source** and select **Plain git remote**. Give the source a short id, for example `gitlab`.

## 2. Add a repository

Choose **Add a repository** and enter its **Remote URL**. speicher.md accepts:

- `https://` URLs, for example `https://gitlab.com/acme/handbook.git`
- `ssh://` URLs, for example `ssh://git@gitlab.example.com/acme/handbook.git`
- the short SSH form git hosts show, for example `git@gitlab.example.com:acme/handbook.git`. speicher.md saves it as an `ssh://` URL.

Plain `http://` and `git://` URLs are refused, because neither lets speicher.md verify the server.

The other fields are optional:

- **Repository id**: identifies the repository within this source. If you leave it empty, speicher.md uses the repository's name from the URL, for example `handbook`. Choose it once and keep it: speicher.md uses it to recognize the repository when its URL or slug changes.
- **URL slug**: the repository's name in speicher.md's URLs. Defaults to the id. If you change it later, the old URLs redirect to the new ones.
- **Branch**: the branch to publish. Defaults to the repository's default branch.
- **Poll interval**: overrides the source's interval for this repository.

Then choose how speicher.md signs in to the server: an access token over HTTPS, or a deploy key over SSH.

### Over HTTPS, with an access token

Every `https://` repository needs a token, even a public one. Create a token that can read the repository, and enter it as **Access token**. Read access to the repository's contents is enough.

The **Username** that goes with the token differs between hosts:

| Host           | Username                    |
| -------------- | --------------------------- |
| GitLab         | `oauth2`                    |
| Bitbucket      | your Bitbucket account name |
| GitHub         | `x-access-token` (default)  |
| Gitea, Forgejo | your account name           |

### Over SSH, with a deploy key

Create a key pair without a passphrase:

```sh
ssh-keygen -t ed25519 -N "" -f speicher-deploy-key
```

Add `speicher-deploy-key.pub` to the repository on your git host as a **read-only deploy key**. Paste the content of `speicher-deploy-key` into **Deploy key** in speicher.md, or drop the file onto the field. speicher.md refuses a key protected by a passphrase, and a public key pasted by mistake.

<!-- screenshot: a repository card with the SSH option and deploy key -->

## 3. Trust the server's host key (SSH only)

Before speicher.md connects to an SSH server, it needs that server's host key, so it can tell the real server from an impostor. As soon as a repository uses an `ssh://` URL, the **Security** card asks for **Known hosts**.

Press **Fetch host keys**. speicher.md asks the server for its keys and shows their fingerprints. **Compare the fingerprints with the ones the server's administrator publishes** before you save. For example, GitLab.com and GitHub list theirs in their documentation. speicher.md never connects to a server whose key is not listed.

You can also paste `known_hosts` lines yourself, for example the output of `ssh-keyscan gitlab.example.com`.

<!-- screenshot: the Security card with fetched fingerprints -->

## 4. Set the poll interval

speicher.md has no webhooks for plain git remotes. It checks each repository for new commits once per **Poll interval**, which is 1 hour by default. A shorter interval publishes changes sooner and fetches more often. Repositories are spread across the interval, so they are not all fetched at once.

To sync a repository right away, run:

```sh
docker compose exec web speicher sync-repo-content <owner>/<repository>
```

## 5. Check the URLs

A repository is served at `/<owner>/<slug>`, where the owner is the path in front of the repository's name in its URL. `https://gitlab.com/acme/handbook.git` is served at `https://<your-host>/acme/handbook`.

Under **Simpler URLs** you can leave out a default repository owner, or make this source the primary one, as described for [GitHub sources](../01-github/index.md#5-choose-the-urls).

## Configuration file

If you keep your configuration in a file instead of the database, a plain git source looks like this:

```yaml
forges:
  gitlab:
    type: git
    poll_interval: 15m
    known_hosts: |
      gitlab.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
    repos:
      - id: handbook
        url: https://gitlab.com/acme/handbook.git
        username: oauth2
        token: ${GITLAB_TOKEN}
      - id: runbooks
        url: ssh://git@gitlab.example.com/platform/runbooks.git
        deploy_key: ${RUNBOOKS_DEPLOY_KEY}
        branch: main
        slug: ops
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
| `forges.<id>.webhook_secret` | string |  | if `type` is `gitlab`, `gitea`, `forgejo` | GitHub only. The secret of the GitHub App's webhook. Without it, speicher.md rejects webhook deliveries and picks up changes only on its regular schedule. |
| `forges.<id>.app_id` | string |  | if `type: github` | GitHub only. The id of the GitHub App, shown at the top of the App's settings page. |
| `forges.<id>.private_key` | string |  | if `type: github` | GitHub only. The private key of the GitHub App, the content of the `.pem` file GitHub generates. |
| `forges.<id>.token` | string |  | if `type` is `gitlab`, `gitea`, `forgejo` | gitlab / gitea / forgejo |
| `forges.<id>.poll_interval` | string | `1h` |  | Git only. How often speicher.md checks each repository of this source for new commits, for example `15m`. Repositories can override it. |
| `forges.<id>.known_hosts` | string |  |  | Git only. The SSH host keys of the servers the `ssh://` repositories are fetched from, as `known_hosts` lines. Required as soon as one repository uses an `ssh://` URL; speicher.md connects only to servers listed here. |
| `forges.<id>.repos` | list of object |  | if `type: git` | Git only. The repositories this source serves. They are listed here because a plain git server cannot be asked for them. |
| `forges.<id>.repos[].id` | string |  | yes | Identifies the repository within this source. Choose it once and keep it: speicher.md uses it to recognize the repository when its URL or slug changes. |
| `forges.<id>.repos[].url` | string |  | yes | The remote URL: `https://host/owner/repo.git` with a `token`, or `ssh://user@host/owner/repo.git` with a `deploy_key`. `http://` and `git://` URLs are refused. |
| `forges.<id>.repos[].slug` | string |  |  | The repository's name in URLs. Defaults to `id`. If you change it, the old URLs redirect to the new ones. |
| `forges.<id>.repos[].branch` | string |  |  | The branch to publish. Defaults to the repository's default branch. |
| `forges.<id>.repos[].deploy_key` | string |  |  | SSH only. The private key of a read-only deploy key, without a passphrase. Required for `ssh://` URLs. |
| `forges.<id>.repos[].token` | string |  |  | HTTPS only. An access token that can read the repository. Required for every `https://` URL, also for public repositories. |
| `forges.<id>.repos[].username` | string | `x-access-token` |  | HTTPS only. The username that goes with the token. It differs between hosts, for example `oauth2` on GitLab. |
| `forges.<id>.repos[].poll_interval` | string |  |  | Overrides the forge-level interval for this repository. |
<!-- prettier-ignore-end -->
<!-- /generated -->
