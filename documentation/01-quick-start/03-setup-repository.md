---
icon: folder-git-2
---

# Publish your first repository

Speicher serves the Markdown files of a git repository. To publish one, you add a small configuration file to it and connect it to your instance.

## 1. Add `.speicher.yaml` to the repository

Create a `.speicher.yaml` file at the root of the repository:

```yaml
version: 1

access:
  groups: [staff]
```

`access` says who may read the repository, as explained in [Access](../03-repository/02-access.md). `staff` is one of the group names you created [during setup](02-setup-instance.md#3-create-groups). Speicher rejects a repository whose root configuration has no `access`, so nothing is published by accident.

Some other settings are useful from the start:

```yaml
version: 1

access:
  groups: [staff]

# Read only this folder, and ignore the rest of the repository
ingest_root: docs

display:
  title: 'Engineering Handbook'
```

Every key is listed under [Repository configuration](../06-reference/04-repository-configuration.md).

Commit and push the file.

## 2. How your files become pages

- Every `.md` file becomes a page, except `README.md` files, and every folder becomes a section in the navigation. To publish `.mdx` files too, add them to [`sync.include`](../03-repository/01-speicher-yaml.md#choosing-files-with-sync).
- A number prefix sets the order and is left out of the URL: `01-install.md` is listed before `02-configure.md` and served as `/install`.
- An `index.md` in a folder becomes the folder's own page.
- Images and other files that your pages link to are served under the same access rules as the pages.

If your repository already uses Docusaurus or Starlight, Speicher reads their sidebar ordering from the frontmatter too.

## 3. Connect the repository

In the dashboard, open **Configuration → Content sources** and add a source:

- **[GitHub App](../02-configuration/03-content-sources/01-github/index.md)**: for repositories on GitHub. Speicher finds every repository the app is installed on, and GitHub notifies it on every push, so changes appear shortly after.
- **[Plain git remote](../02-configuration/03-content-sources/02-plain-git-remote/index.md)**: for any other git host, such as GitLab, Gitea, Forgejo or Bitbucket. Give the repository's `https://` URL with an access token, or its `ssh://` URL with a read-only deploy key. Speicher checks the remote for changes every hour by default.

:::note
A repository is only served after its `.speicher.yaml` has been read, so connecting a repository that has none publishes nothing.
:::

## 4. Wait for the first sync

The worker now clones the repository and builds its pages and search index. **Sync status** in the dashboard shows the progress, and the error if a sync fails.

To sync a repository right away instead of waiting for the next check, run:

```sh
docker compose exec web speicher sync-repo-content <owner>/<repository>
```

## 5. Open it

A repository is served at `/<owner>/<repository>`, where the owner is the account or organization in its URL. `https://github.com/acme/handbook` is served at `https://<your-host>/acme/handbook`.

Everyone in a group that its `access` lists can now read it after signing in.

## Next steps

- [Control who can read what](../03-repository/02-access.md): restrict folders further, grant access to individual people, or publish pages to the public.
- [Connect an AI assistant](../04-ai-assistants/01-index.mdx) to chat with your documentation.
