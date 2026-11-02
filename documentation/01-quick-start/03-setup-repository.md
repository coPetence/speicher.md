---
icon: folder-git-2
---

# Publish your first repository

Speicher publishes a Git repository once it has a `.speicher.yaml` file at its root and a content source of your instance has access to the repository. Each Markdown file becomes a page at `/<owner>/<repository>/…`. It can be read by the groups configured under `access` in the `.speicher.yaml`.

## 1. Add `.speicher.yaml` to the repository

Create a `.speicher.yaml` file at the root of the repository:

```yaml
version: 1

access:
  groups: [staff]
```

`access` defines who may read the repository, as explained in [Access](../03-repository/02-access.md). `staff` is one of the group names you created [during setup](02-setup-instance.md#3-create-groups). Speicher rejects a repository whose root configuration has no `access`, so nothing can be published by accident.

Some other settings that are useful from the start:

```yaml
version: 1

access:
  groups: [staff]

# Read only this folder, and ignore the rest of the repository
ingest_root: docs

display:
  title: 'Engineering Handbook'
```

Every key you can use here is listed under [Repository configuration](../06-reference/04-repository-configuration.md).

When you're done, commit and push the file.

## 2. How your files become pages

- **Pages:** every `.md` and `.mdx` file becomes a page. `README.md` files are excluded by default. To change which files are ingested, set [`sync.include` and `sync.exclude`](../03-repository/01-speicher-yaml.md#choosing-files-with-sync).
- **URLs:** a page's URL is its path in the repository, in lower case and without the extension. `guides/Setup.md` is served at `/<owner>/<repository>/guides/setup`.
- **Folders:** every folder becomes a section in the navigation. If you want to have a custom page for a folder, create an `index.md` or `index.mdx` file in that folder and it will be served at the folder's own URL.
- **Order:** a number prefix of up to three digits, followed by `-`, `_`, `.` or a space, sets the position in the navigation and is left out of the URL. `01-install.md` is listed before `02-configure.md` and served at `…/install`. Files without a prefix can be ordered with `sidebar_position` (Docusaurus) or `sidebar.order` (Starlight) in the frontmatter.
- **Titles:** the page title is the `title` in the frontmatter, otherwise the first `# Heading`, otherwise the file name. See [Page title](../03-repository/03-markdown-syntax.md#page-title).
- **Files:** PNG, JPEG, GIF, WebP, AVIF and SVG images that a page links to are served with the same access rules as the page. Other file types, such as BMP images, are only downloaded when you add them to [`sync.include`](../03-repository/01-speicher-yaml.md#choosing-files-with-sync).

## 3. Give the content source access to the repository

Speicher reads the repository through the content source you added [during setup](02-setup-instance.md#4-add-a-content-source). Make sure that source covers this repository:

- **GitHub App:** the App must be installed on the repository. If you installed it on selected repositories only, add this one, as described in [Install the App](../02-configuration/03-content-sources/01-github/index.md#3-install-the-app).
- **Plain git remote:** the source reads only the repositories listed in it. Add this one by its remote URL, as described in [Add a repository](../02-configuration/03-content-sources/02-plain-git-remote/index.md#2-add-a-repository).

If you have no content source yet, add one first, as described in [Add a content source](02-setup-instance.md#4-add-a-content-source).

## 4. Wait for the first sync

The worker now clones the repository and builds its pages and search index. To see the progress of the synchronization, check the **Sync status** page in the dashboard.

To sync a repository right away instead of waiting for the next check, run:

```sh
docker compose exec web speicher sync-repo-content <owner>/<repository>
```

## 5. Open it

A repository is served at `/<owner>/<repository>`, where the owner is the account or organization in its URL. `https://github.com/acme/handbook` is served at `https://<your-host>/acme/handbook`.

After signing in, the members of the groups listed under `access` in `.speicher.yaml` can read the repository. With `groups: [staff]` from step 1, that is everyone in `staff`.

## Next steps

- [Access](../03-repository/02-access.md): narrow access in individual folders with their own `.speicher.yaml`, grant individual people access until a set date, or make pages publicly available without sign-in.
- [Connect an AI assistant](../04-ai-assistants/01-index.mdx) to chat with your documentation.
