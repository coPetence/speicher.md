---
icon: globe
---

# Public access

By default, every page needs a sign-in. To publish pages to visitors who are not signed in, two settings have to agree:

1. **The instance allows it.** An administrator lists the repository under **Configuration → Public access**.
2. **The repository grants it.** Its `.speicher.yaml` gives access to `public`.

## 1. Allow the repository

In the configuration file, the allowed repositories are listed under `public.repos`:

```yaml
public:
  repos:
    - acme/handbook
    - acme/api-docs
```

Each entry is the repository's owner and name, as `<owner>/<repository>`. Use the owner even if the repository's URL leaves it out.

Changing the list rebuilds every repository, so pages become public or private again once the rebuild is done.

## 2. Grant access in the repository

In the repository's `.speicher.yaml`, add `public` to `access`. `public` is a group everyone is in, including visitors who are not signed in:

```yaml
version: 1
access: [public]
```

To publish only part of a repository, grant `public` at the root and narrow the folders that stay internal. [Access](../../03-repository/02-access.md#making-pages-public) shows an example.

:::caution
If a repository grants `public` but is not listed under `public.repos`, the sync rejects its configuration with the problem `public-not-enabled`, and the repository's pages stay as they were. `maintainers` can never name `public`.
:::

## What visitors get

Visitors who are not signed in can:

- read the public pages and the files stored next to them
- see public pages in the navigation and in search results, and nothing else
- use the MCP server with an AI assistant, limited to public pages. When no repository is public, the MCP server asks every caller to sign in.

When at least one repository is public, `robots.txt` allows search engines to crawl the public pages and points them to `sitemap.xml`. The sitemap lists every public page. It needs `SPEICHER_PUBLIC_URL` to be set, since Speicher does not build absolute URLs from the request. When no repository is public, `robots.txt` blocks all crawlers and there is no sitemap.

## Caching and rate limiting

Pages that visitors who are not signed in receive are marked as cacheable, so a CDN or proxy in front of Speicher can serve them. Pages for signed-in people are never cached.

Requests from visitors who are not signed in are rate-limited per IP address when they carry query parameters, as a search does. Plain page views are not counted. People who are signed in are never limited.

<!-- generated: env-vars SPEICHER_PUBLIC_MAX_AGE,SPEICHER_ANON_RATE_LIMIT,SPEICHER_PUBLIC_URL -->
<!-- prettier-ignore-start -->
| Variable | Default | Read by | Description |
| -------- | ------- | ------- | ----------- |
| `SPEICHER_PUBLIC_MAX_AGE` | `60` | web | Cache-Control `max-age` for anonymous responses, in seconds. Use `0` to disable public caching. |
| `SPEICHER_ANON_RATE_LIMIT` | `60` | web | Anonymous requests allowed per minute per client IP. Signed-in users are exempt. Use `0` for no limit. |
| `SPEICHER_PUBLIC_URL` | — | web + worker | Public instance URL for webhooks, magic links, and the sitemap. Uses the request host if unset. |
<!-- prettier-ignore-end -->
<!-- /generated -->

## All settings

<!-- generated: schema instance#/properties/public -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `public` | object |  |  | Repositories that may publish pages to visitors who are not signed in. Listing a repository only allows it: its own `access` must also name `public`. |
| `public.repos` | list of string |  | yes | Repositories as `<owner>/<repository>`, the owner being the account or organization the repository belongs to, even where its URL leaves the owner out. Each listed repository may grant `access` to `public`. |
<!-- prettier-ignore-end -->
<!-- /generated -->
