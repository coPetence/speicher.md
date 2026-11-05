---
icon: settings
---

# Instance configuration

Every key of the instance configuration, the `speicher.instance.yaml` file or the configuration stored in the database. Only this file may reference environment variables as `${VAR}`.

<!-- generated: schema instance without:embedding,notify,analytics -->
<!-- prettier-ignore-start -->
## version

**Type:** `1` · **Required**

## mail

**Type:** object

Configure SMTP to send sign-in links. Required for magic-link providers.

### `mail.host`

**Type:** string · **Required**

Enter your SMTP hostname, such as `smtp.example.com`.

### `mail.port`

**Type:** integer · **Default:** `587`

Enter your SMTP port. Port `465` uses TLS immediately; other ports use STARTTLS if available.

### `mail.username`

**Type:** string

Enter your SMTP username. Omit if your server needs no authentication.

### `mail.password`

**Type:** string

Enter your SMTP password or an environment variable reference, such as `${SMTP_PASSWORD}`.

### `mail.from`

**Type:** string

Enter an allowed sender address, optionally as `Name <address>`. Defaults to the brand name and the `username` email address, or `noreply@<public-host>` from `SPEICHER_PUBLIC_URL`. Example: `Docs <docs@example.com>`.

### `mail.reply_to`

**Type:** string

Enter a reply address if replies should go somewhere other than the sender.

## assets

**Type:** object

Where asset bytes live. Metadata and ACLs always stay in Postgres; the browser never talks to the store directly — every read is proxied through the app after the authz check.

### `assets.driver`

**Type:** `filesystem`, `s3`, `azure` · **Default:** `filesystem` · **Required**

### `assets.path`

**Type:** string · **Required if** `driver: filesystem`

filesystem: volume mount path. Single replica, or an RWX volume.

### `assets.bucket`

**Type:** string · **Required if** `driver: s3`

s3

### `assets.endpoint`

**Type:** string (uri)

s3: for non-AWS providers such as Hetzner Object Storage or MinIO. azure: a blob endpoint other than `https://<account>.blob.core.windows.net` — a sovereign cloud, or Azurite in development. Give the account URL, not the container's: the container is appended.

### `assets.region`

**Type:** string · **Required if** `driver: s3`

s3

### `assets.access_key_id`

**Type:** string

s3

### `assets.secret_access_key`

**Type:** string

s3

### `assets.account`

**Type:** string · **Required if** `driver: azure`

azure: storage account name.

### `assets.container`

**Type:** string · **Required if** `driver: azure`

azure: the container, which this instance never creates — a data-plane role cannot, so it is the operator's to make.

### `assets.auth`

**Type:** `key`, `connection_string`, `managed_identity`, `workload_identity`, `default` · **Default:** `key`

azure: how this instance proves who it is, and the default is `key` because it is the one an operator configuring this from a browser already has. `key` and `connection_string` are secrets this instance holds; a managed identity avoids holding one and is worth moving to once the storage account and this deployment are in the same directory. `managed_identity` is the identity of the host — a VM, Container App or App Service — and `workload_identity` is the federated token an AKS pod is handed; they are different mechanisms and the wrong one fails as a timeout rather than as a refusal, so it is named here rather than guessed. `default` walks the SDK's whole chain including the developer's `az` login: it is a development convenience, and in production it means no single answer to which identity this is running as — so `/-/config` does not offer it there.

### `assets.connection_string`

**Type:** string · **Required if** `driver: azure` and `auth: connection_string`

azure: required when `auth` is `connection_string`. It carries its own endpoint, so `endpoint` is not consulted alongside it.

### `assets.account_key`

**Type:** string · **Required if** `driver: azure` and `auth: key`

azure: the storage account key, required when `auth` is `key`. A long-lived shared secret that grants the whole account — prefer a managed identity, which grants a role on one container and cannot be copied out of the process.

### `assets.client_id`

**Type:** string

azure: the user-assigned identity to use, when `auth` resolves a token. Absent means the system-assigned one. Under `workload_identity` the AKS webhook normally injects this into the pod as `AZURE_CLIENT_ID` and the SDK reads it — set it here only to override that.

### `assets.tenant_id`

**Type:** string

azure: the directory to authenticate against, when `auth` is `workload_identity` and the environment does not already say.

### `assets.max_asset_bytes`

**Type:** integer · **Default:** `10000000`

### `assets.presign_over_bytes`

**Type:** integer · **Default:** `0`

Assets larger than this are delivered by presigned redirect after the authz check, instead of proxied. 0 disables presigning. Never applied to inline images.

### `assets.presign_ttl`

**Type:** string · **Default:** `60s`

Presigned URLs are bearer capabilities valid until expiry regardless of the ACL. Keep short.

## theme

**Type:** object

How pages look: the template, the typeface and colour overrides. Changes apply right away and never trigger a sync.

### `theme.template`

**Type:** string · **Default:** `default`

The template for all pages: `default`, `blueprint`, `editorial` or `workspace`. An unknown name falls back to `default`.

### `theme.font`

**Type:** `system`, `sans`, `serif`, `mono` · **Default:** `system`

The typeface of the body text. Each value uses fonts already installed on the reader's device; web fonts are not loaded.

### `theme.rounded_corners`

**Type:** boolean · **Default:** `true`

Whether corners are rounded. Off sets every corner radius to 0, whatever the template chooses.

### `theme.tui`

**Type:** boolean · **Default:** `false`

Whether pages look like a terminal: monospace text, square corners and terminal-style headings, links and lists. Works with every template.

### `theme.palette`

**Type:** object

The palette replaces individual colours of the template. It is used to match the documentation and the admin pages to your brand colours. Colours you leave empty keep the default colours.

### `theme.palette.light`

**Type:** object

Colours for readers in light mode.

### `theme.palette.light.bg`

**Type:** string

The page.

### `theme.palette.light.fg`

**Type:** string

Body text.

### `theme.palette.light.accent`

**Type:** string

Links, focus rings and anything the eye is meant to go to.

### `theme.palette.light.muted`

**Type:** string

Quiet text — captions, metadata, punctuation in code. Mixed from `fg` and `bg` when unset.

### `theme.palette.light.line`

**Type:** string

Rules, borders and table hairlines. Mixed from `fg` and `bg` when unset.

### `theme.palette.light.surface`

**Type:** string

Panels that sit on the page — code blocks, the tree, table heads. Mixed from `fg` and `bg` when unset.

### `theme.palette.light.warn-bg`

**Type:** string

Behind a warning strip — the banner over a page whose repository is failing to sync.

### `theme.palette.light.warn-fg`

**Type:** string

The words on that strip. It is read against `warn-bg` and against nothing else.

### `theme.palette.light.mark-bg`

**Type:** string

Behind a search term highlighted in a result snippet.

### `theme.palette.light.mark-fg`

**Type:** string

The highlighted term itself.

### `theme.palette.light.callout-info`

**Type:** string

The `info` callout, and the note icon beside it.

### `theme.palette.light.callout-tip`

**Type:** string

The `tip` callout.

### `theme.palette.light.callout-important`

**Type:** string

The `important` callout.

### `theme.palette.light.callout-warning`

**Type:** string

The `warning` callout. It also colours the `warn` state on the operational surface.

### `theme.palette.light.callout-danger`

**Type:** string

The `danger` callout, and the `fail` state on the operational surface.

### `theme.palette.light.code-keyword`

**Type:** string

Keywords — `if`, `return`, `class`.

### `theme.palette.light.code-type`

**Type:** string

Type names and class names.

### `theme.palette.light.code-function`

**Type:** string

Function and method names.

### `theme.palette.light.code-tag`

**Type:** string

Markup tag names.

### `theme.palette.light.code-attr`

**Type:** string

Markup attribute names, and object keys.

### `theme.palette.light.code-string`

**Type:** string

String literals.

### `theme.palette.light.code-number`

**Type:** string

Numeric and boolean literals.

### `theme.palette.light.code-variable`

**Type:** string

Variables, and interpolations inside a string.

### `theme.palette.light.code-comment`

**Type:** string

Comments.

### `theme.palette.light.code-meta`

**Type:** string

Preprocessor lines, shebangs, annotations.

### `theme.palette.light.code-inserted`

**Type:** string

An added line in a diff.

### `theme.palette.light.code-inserted-bg`

**Type:** string

Behind that line.

### `theme.palette.light.code-deleted`

**Type:** string

A removed line in a diff.

### `theme.palette.light.code-deleted-bg`

**Type:** string

Behind that line.

### `theme.palette.dark`

**Type:** object

Colours for readers in dark mode. Left out, the template's dark colours are used.

### `theme.palette.dark.bg`

**Type:** string

The page.

### `theme.palette.dark.fg`

**Type:** string

Body text.

### `theme.palette.dark.accent`

**Type:** string

Links, focus rings and anything the eye is meant to go to.

### `theme.palette.dark.muted`

**Type:** string

Quiet text — captions, metadata, punctuation in code. Mixed from `fg` and `bg` when unset.

### `theme.palette.dark.line`

**Type:** string

Rules, borders and table hairlines. Mixed from `fg` and `bg` when unset.

### `theme.palette.dark.surface`

**Type:** string

Panels that sit on the page — code blocks, the tree, table heads. Mixed from `fg` and `bg` when unset.

### `theme.palette.dark.warn-bg`

**Type:** string

Behind a warning strip — the banner over a page whose repository is failing to sync.

### `theme.palette.dark.warn-fg`

**Type:** string

The words on that strip. It is read against `warn-bg` and against nothing else.

### `theme.palette.dark.mark-bg`

**Type:** string

Behind a search term highlighted in a result snippet.

### `theme.palette.dark.mark-fg`

**Type:** string

The highlighted term itself.

### `theme.palette.dark.callout-info`

**Type:** string

The `info` callout, and the note icon beside it.

### `theme.palette.dark.callout-tip`

**Type:** string

The `tip` callout.

### `theme.palette.dark.callout-important`

**Type:** string

The `important` callout.

### `theme.palette.dark.callout-warning`

**Type:** string

The `warning` callout. It also colours the `warn` state on the operational surface.

### `theme.palette.dark.callout-danger`

**Type:** string

The `danger` callout, and the `fail` state on the operational surface.

### `theme.palette.dark.code-keyword`

**Type:** string

Keywords — `if`, `return`, `class`.

### `theme.palette.dark.code-type`

**Type:** string

Type names and class names.

### `theme.palette.dark.code-function`

**Type:** string

Function and method names.

### `theme.palette.dark.code-tag`

**Type:** string

Markup tag names.

### `theme.palette.dark.code-attr`

**Type:** string

Markup attribute names, and object keys.

### `theme.palette.dark.code-string`

**Type:** string

String literals.

### `theme.palette.dark.code-number`

**Type:** string

Numeric and boolean literals.

### `theme.palette.dark.code-variable`

**Type:** string

Variables, and interpolations inside a string.

### `theme.palette.dark.code-comment`

**Type:** string

Comments.

### `theme.palette.dark.code-meta`

**Type:** string

Preprocessor lines, shebangs, annotations.

### `theme.palette.dark.code-inserted`

**Type:** string

An added line in a diff.

### `theme.palette.dark.code-inserted-bg`

**Type:** string

Behind that line.

### `theme.palette.dark.code-deleted`

**Type:** string

A removed line in a diff.

### `theme.palette.dark.code-deleted-bg`

**Type:** string

Behind that line.

## brand

**Type:** object

The name, logos and favicon in the page header and browser tab. Only the instance sets these; repositories cannot.

### `brand.name`

**Type:** string

The name shown at the top of every page, linking to the home page. It is also the logo's alt text. Without it, the header shows the host of `SPEICHER_PUBLIC_URL`. Example: `Acme Engineering Docs`.

### `brand.show_name`

**Type:** boolean · **Default:** `true`

Whether the name is shown beside the logo. Turn it off if your logo already contains the name. Without a logo, the name is always shown. Example: `false`.

### `brand.name_align`

**Type:** `center`, `bottom` · **Default:** `center`

How the name lines up with the logo: `center` centres it on the logo's height, `bottom` sets it on the logo's bottom edge. Example: `bottom`.

### `brand.logo`

**Type:** string

The header logo: a PNG, WebP or SVG of at most 1 MB, as a `data:` URI or a `sha256:` reference to an uploaded image. Used in dark mode too, unless `logo_dark` is set.

### `brand.logo_dark`

**Type:** string

The header logo for readers in dark mode: a PNG, WebP or SVG of at most 1 MB, as a `data:` URI or a `sha256:` reference to an uploaded image.

### `brand.icon`

**Type:** string

The favicon shown in the browser tab: a square PNG or SVG of at most 1 MB, as a `data:` URI or a `sha256:` reference to an uploaded image. A PNG must be at least 32×32 pixels.

### `brand.wallpaper`

**Type:** string

Wallpaper behind the pages as base64 data URI (max 5 MB JPEG, PNG, WebP or SVG)

### `brand.wallpaper_dark`

**Type:** string

Wallpaper for dark mode as base64 data URI (max 5 MB JPEG, PNG, WebP or SVG)

### `brand.wallpaper_all_themes`

**Type:** boolean · **Default:** `false`

Whether the uploaded wallpaper is shown in every theme. When this is turned off, only themes with a wallpaper of their own, such as Glass, show it.

## attribution

**Type:** boolean · **Default:** `true`

Whether pages show `Published with speicher.md` at the bottom, linking to the speicher.md website. The text cannot be changed. Example: `false`.

## graph

**Type:** object

Features built from the links between pages: the related column, hover previews, tags and link-weighted search. speicher.md records links on every sync, so changes apply right away. A reader only sees links between pages they can read.

### `graph.enabled`

**Type:** boolean · **Default:** `true`

Turns all link graph features on or off. When off, the settings below have no effect.

### `graph.related`

**Type:** boolean · **Default:** `true`

Shows a column beside each article with the pages it links to and the pages that link to it.

### `graph.previews`

**Type:** boolean · **Default:** `true`

Shows the title and description of the target page when a reader hovers over a link to another page. Links to pages the reader cannot open get no preview.

### `graph.terms`

**Type:** boolean · **Default:** `true`

Shows a page's frontmatter `tags` as chips, each leading to a list of the pages with that tag that the reader can open.

### `graph.search_boost`

**Type:** boolean · **Default:** `true`

Ranks a search result higher when other results of the same search link to it. It changes only the order of results.

### `graph.related_limit`

**Type:** integer · **Default:** `8`

The most entries shown in each list of the related column. Between 1 and 50.

## autolink

**Type:** object

Web addresses that are written in a page automatically become links. Changing this setting rebuilds every repository.

### `autolink.exclude_domains`

**Type:** list of string

The domains that will not be automatically converted to links, for example `speicher.md`. A subdomain such as `docs.speicher.md` needs its own entry. A link written with `https://` or as a Markdown link will stay a link.

## auth

**Type:** object

Optional, and absent on an instance nobody has configured yet: there is then no way to sign in, so every caller holds `group:public` and nothing else. Present means at least one provider — absent and present-but-empty are different claims, and only the first is a fresh instance.

### `auth.default_provider`

**Type:** string

Provider assumed when an individual grant omits `provider`. Without it, an unqualified grant is rejected — never guessed.

### `auth.providers`

**Type:** map · **Required**

### `auth.providers.<id>`

**Type:** one of `type: oidc`, `type: magic-link`, `type: github`

### `auth.providers.<id>` with `type: oidc`

#### `auth.providers.<id>.type`

**Type:** `oidc` · **Default:** `oidc`

Selects the OpenID Connect provider. Use it for any provider that supports OpenID Connect, such as Google, Keycloak or Okta.

#### `auth.providers.<id>.display_name`

**Type:** string

The name the sign-in page shows for this provider, for example `Google`. Defaults to the provider's id.

#### `auth.providers.<id>.issuer`

**Type:** string (uri) · **Required**

The address of the provider's OpenID Connect server, for example `https://accounts.google.com`. speicher.md reads the provider's settings from `<issuer>/.well-known/openid-configuration`, and refuses an issuer that does not name a single tenant or realm.

#### `auth.providers.<id>.client_id`

**Type:** string · **Required**

The client id of the application you registered for speicher.md at the provider.

#### `auth.providers.<id>.client_secret`

**Type:** string

The client secret of that application. Leave it out only if the provider registered speicher.md as a public client.

#### `auth.providers.<id>.subject_claim`

**Type:** string · **Default:** `sub`

The claim in the sign-in token that holds the person's permanent id. Most providers use `sub`.

#### `auth.providers.<id>.groups_claim`

**Type:** string · **Default:** `groups`

The claim in the sign-in token that lists the person's groups. Without it, or if the provider sends none (such as Google), the person belongs to no provider groups and can only be added to groups by email or subject.

#### `auth.providers.<id>.email_claim`

**Type:** string · **Default:** `email`

The claim in the sign-in token that holds the person's email address. Access granted by email is matched against it.

#### `auth.providers.<id>.domains`

**Type:** list of string

Offer this provider only for addresses at these domains. Absent means it is offered for every address.

#### `auth.providers.<id>.session_ttl`

**Type:** string · **Default:** `8h`

How long a sign-in stays valid. Groups are read only at sign-in, so a removed group membership keeps working until the session ends.

#### `auth.providers.<id>.connection_idle_ttl`

**Type:** string · **Default:** `30d`

If you have a directory configured, this is how long a connection persists while not used. Without a directory, a connection ends with `session_ttl`.

#### `auth.providers.<id>.directory`

**Type:** object

Optional read access to the provider's directory. speicher.md uses it to resolve email grants to people, count group members and notice people who have left.

#### `auth.providers.<id>.directory.type`

**Type:** `graph`, `github` · **Required**

graph = Microsoft Graph; github = GitHub organisation API

#### `auth.providers.<id>.directory.tenant_id`

**Type:** string

graph: the id of the Entra tenant to read.

#### `auth.providers.<id>.directory.client_id`

**Type:** string

graph. Usually a separate app registration from the delegated-flow client: application permissions such as User.Read.All need admin consent.

#### `auth.providers.<id>.directory.client_secret`

**Type:** string

graph: the client secret of the directory application.

#### `auth.providers.<id>.directory.app_id`

**Type:** string

github. The App id for the directory GitHub App

#### `auth.providers.<id>.directory.private_key`

**Type:** string

github. The PEM of the App named

#### `auth.providers.<id>.directory.webhook_secret`

**Type:** string

github. This secret is used to sign the webhook deliveries of the App.

#### `auth.providers.<id>.directory.cache_ttl`

**Type:** string · **Default:** `1h`

How long directory answers are cached before speicher.md asks again.

### `auth.providers.<id>` with `type: magic-link`

#### `auth.providers.<id>.type`

**Type:** `magic-link` · **Required**

Selects the magic-link provider, which signs people in with a link sent to their email address. Needs `mail`.

#### `auth.providers.<id>.display_name`

**Type:** string

The name the sign-in page shows for this provider, for example `Email link`. Defaults to the provider's id.

#### `auth.providers.<id>.token_ttl`

**Type:** string · **Default:** `15m`

How long a sign-in link stays valid after it is sent. A link can be used only once.

#### `auth.providers.<id>.session_ttl`

**Type:** string · **Default:** `30d`

How long a sign-in stays valid.

#### `auth.providers.<id>.same_browser`

**Type:** boolean · **Default:** `true`

Whether a link only works in the browser it was requested from. Turn it off to let people request a link on one device and open it on another.

#### `auth.providers.<id>.domains`

**Type:** list of string

Offer this provider only for addresses at these domains. Absent means it is offered for every address.

### `auth.providers.<id>` with `type: github`

#### `auth.providers.<id>.type`

**Type:** `github` · **Required**

#### `auth.providers.<id>.display_name`

**Type:** string

What a reader is offered this provider *as* — "Sign in with Acme Account".

#### `auth.providers.<id>.client_id`

**Type:** string · **Required**

#### `auth.providers.<id>.client_secret`

**Type:** string

#### `auth.providers.<id>.base_url`

**Type:** string (uri)

GitHub Enterprise Server only.

#### `auth.providers.<id>.session_ttl`

**Type:** string · **Default:** `8h`

Team memberships are read once, at sign-in, so a team somebody has been taken out of keeps working for them until this expires and they sign in again.

#### `auth.providers.<id>.connection_idle_ttl`

**Type:** string · **Default:** `30d`

If you have a directory configured, this is how long a connection persists while not used. Without a directory, a connection ends with `session_ttl`.

#### `auth.providers.<id>.domains`

**Type:** list of string

Offer this provider only for addresses at these domains. Absent means it is offered for every address.

#### `auth.providers.<id>.directory`

**Type:** object

Optional per-provider directory access. Enables email -> subject resolution at ingest, group-size counts in the pull-request check, and detection of departed principals. Omit it and email grants match on `email_claim` instead, with counts absent from the check.

#### `auth.providers.<id>.directory.type`

**Type:** `graph`, `github` · **Required**

graph = Microsoft Graph; github = GitHub organisation API

#### `auth.providers.<id>.directory.tenant_id`

**Type:** string

graph: the id of the Entra tenant to read.

#### `auth.providers.<id>.directory.client_id`

**Type:** string

graph. Usually a separate app registration from the delegated-flow client: application permissions such as User.Read.All need admin consent.

#### `auth.providers.<id>.directory.client_secret`

**Type:** string

graph: the client secret of the directory application.

#### `auth.providers.<id>.directory.app_id`

**Type:** string

github. The App id for the directory GitHub App

#### `auth.providers.<id>.directory.private_key`

**Type:** string

github. The PEM of the App named

#### `auth.providers.<id>.directory.webhook_secret`

**Type:** string

github. This secret is used to sign the webhook deliveries of the App.

#### `auth.providers.<id>.directory.cache_ttl`

**Type:** string · **Default:** `1h`

How long directory answers are cached before speicher.md asks again.

#### `auth.providers.<id>.app`

**Type:** object

The GitHub App of this provider.

#### `auth.providers.<id>.app.client_id`

**Type:** string · **Required**

The client id of the App. The entry is ignored once client_id names another App.

#### `auth.providers.<id>.app.slug`

**Type:** string · **Required**

The name of the App in its URLs.

#### `auth.providers.<id>.app.owner_account`

**Type:** string · **Required**

The GitHub account the App belongs to.

#### `auth.providers.<id>.app.owner_is_organization`

**Type:** boolean · **Required**

#### `auth.providers.<id>.app.public`

**Type:** boolean

Whether anyone with a GitHub account can sign in with the App. A private App takes only the members of the account it belongs to. Absent when the App was not created by speicher.md.

## admins

**Type:** object

Who administers this instance: the people and groups who can open the configuration and sync status of every repository under `/-/`. Administrators get no read access to content from this. A configuration that leaves nobody as administrator cannot be saved.

### `admins.groups`

**Type:** list of string

Groups whose members are administrators. Each must be a group defined under `groups`, and at least one administrator group needs members unless `users` names someone.

### `admins.users`

**Type:** list of object

Individual administrators, each named by `email`, or by `subject` with a `note`.

### `admins.users[]`

**Type:** object

Set exactly one of: `subject` + `note`, `email`.

### `admins.users[].provider`

**Type:** string

Short id of the identity provider the person signs in with. Can be left out when the instance has one provider or sets `auth.default_provider`.

### `admins.users[].subject`

**Type:** string

Value of the provider's subject_claim. For a magic-link provider the subject IS the lowercased email address.

### `admins.users[].email`

**Type:** string (email)

The person's email address, matched at every request against the address the identity provider reports at sign-in. Use `subject` for a grant that should survive a change of address.

### `admins.users[].note`

**Type:** string

Who this entry is for, such as a name and role. Required with `subject`.

### `admins.users[].until`

**Type:** string (date)

Optional for admins; mandatory for content grants.

## groups

**Type:** map

References another speicher.md group by its internal name. All members of the referenced groups will be members of this group.

### `groups.<name>`

**Type:** list of object

### `groups.<name>[]`

**Type:** object

The source of a group membership. Can be a directory group id, an email domain for a magic-link provider, one persons email, or a reference to another group by its internal name. Exactly one of the five keys must be present. Set exactly one of: `provider` + `id`, `provider` + `domain`, `provider` + `subject`, `provider` + `email`, `group`.

### `groups.<name>[].provider`

**Type:** string

Short ID of the identity provider you want to reference.

### `groups.<name>[].id`

**Type:** string

Group id as the provider emits it in groups_claim (oidc), or "org/team-slug" (github).

### `groups.<name>[].subject`

**Type:** string

Value of the provider's subject_claim, naming one person rather than a mapping. For a magic-link provider the subject IS the lowercased email address. The strongest of the four keys: a subject is assigned by the provider and cannot be set by the person it identifies, so it survives a rename and cannot be claimed by somebody else.

### `groups.<name>[].email`

**Type:** string (email)

Address of one person, matched against the provider's email_claim. Mutable, reassignable, and on some providers set by a directory administrator rather than proven by the mailbox — so this is the convenient form and `subject` is the durable one. Refused on a provider whose issuer does not name one directory; see the loader.

### `groups.<name>[].group`

**Type:** string

The internal name of another group. Every member of that group is a member of this one.

### `groups.<name>[].note`

**Type:** string

Optional free text for later reference.

### `groups.<name>[].until`

**Type:** string (date)

Optional expiry date. A group source will loose effect after this date. If it's not set the source will be permanent.

### `groups.<name>[].domain`

**Type:** string

Email domain as the group. magic-link providers only. The "address already appears in some ACL" check that gates link sending includes domain membership. Never use a freemail domain — it would grant anyone who can receive mail there.

## public

**Type:** object

Repositories that may publish pages to visitors who are not signed in. Listing a repository only allows it: its own `access` must also name `public`.

### `public.repos`

**Type:** list of string · **Required**

Repositories as `<owner>/<repository>`, the owner being the account or organization the repository belongs to, even where its URL leaves the owner out. Each listed repository may grant `access` to `public`.

## forges

**Type:** map

Where documentation is read from. Optional, and may be empty: an instance with no content source loads, serves nothing and can be administered — which is the state every instance is in before its first source is configured, and the state it returns to when the last one is removed. Requiring one meant the first boot needed a forge the operator could not add until the instance was running.

### `forges.<id>`

**Type:** object

### `forges.<id>.type`

**Type:** `github`, `gitlab`, `gitea`, `forgejo`, `git` · **Required**

The kind of source. `github` reads repositories through a GitHub App; `git` reads repositories you list from any git server over HTTPS or SSH.

### `forges.<id>.primary`

**Type:** boolean · **Default:** `false`

Whether this source's id is left out of its repositories' URLs. Only one source can be primary; when there is only one source, it is primary. Repositories of other sources are served under `/<source-id>/…`.

### `forges.<id>.default_repository_owner`

**Type:** string

The user or organization whose name is left out of the URL, so its repositories are served at `/<repo>` instead of `/<owner>/<repo>`. Repositories of other owners keep the owner in their URL.

### `forges.<id>.base_url`

**Type:** string (uri)

GitHub only. The address of your GitHub Enterprise Server, for example `https://github.example.com`. Leave it empty for GitHub.com.

### `forges.<id>.webhook_secret`

**Type:** string · **Required if** `type` is `gitlab`, `gitea`, `forgejo`

GitHub only. The secret of the GitHub App's webhook. Without it, speicher.md rejects webhook deliveries and picks up changes only on its regular schedule.

### `forges.<id>.app_id`

**Type:** string · **Required if** `type: github`

GitHub only. The id of the GitHub App, shown at the top of the App's settings page.

### `forges.<id>.private_key`

**Type:** string · **Required if** `type: github`

GitHub only. The private key of the GitHub App, the content of the `.pem` file GitHub generates.

### `forges.<id>.token`

**Type:** string · **Required if** `type` is `gitlab`, `gitea`, `forgejo`

gitlab / gitea / forgejo

### `forges.<id>.poll_interval`

**Type:** string · **Default:** `1h`

Git only. How often speicher.md checks each repository of this source for new commits, for example `15m`. Repositories can override it.

### `forges.<id>.known_hosts`

**Type:** string

Git only. The SSH host keys of the servers the `ssh://` repositories are fetched from, as `known_hosts` lines. Required as soon as one repository uses an `ssh://` URL; speicher.md connects only to servers listed here.

### `forges.<id>.repos`

**Type:** list of object · **Required if** `type: git`

Git only. The repositories this source serves. They are listed here because a plain git server cannot be asked for them.

### `forges.<id>.repos[].id`

**Type:** string · **Required**

Identifies the repository within this source. Choose it once and keep it: speicher.md uses it to recognize the repository when its URL or slug changes.

### `forges.<id>.repos[].url`

**Type:** string · **Required**

The remote URL: `https://host/owner/repo.git` with a `token`, or `ssh://user@host/owner/repo.git` with a `deploy_key`. `http://` and `git://` URLs are refused.

### `forges.<id>.repos[].slug`

**Type:** string

The repository's name in URLs. Defaults to `id`. If you change it, the old URLs redirect to the new ones.

### `forges.<id>.repos[].branch`

**Type:** string

The branch to publish. Defaults to the repository's default branch.

### `forges.<id>.repos[].deploy_key`

**Type:** string

SSH only. The private key of a read-only deploy key, without a passphrase. Required for `ssh://` URLs.

### `forges.<id>.repos[].token`

**Type:** string

HTTPS only. An access token that can read the repository. Required for every `https://` URL, also for public repositories.

### `forges.<id>.repos[].username`

**Type:** string · **Default:** `x-access-token`

HTTPS only. The username that goes with the token. It differs between hosts, for example `oauth2` on GitLab.

### `forges.<id>.repos[].poll_interval`

**Type:** string

Overrides the forge-level interval for this repository.

## defaults

**Type:** object

Starting values for every repository. A repository's root `.speicher.yaml` changes them the same way a folder's file does.

### `defaults.sync`

**Type:** object

### `defaults.sync.include`

**Type:** list of string

The include list determines which files will be downloaded from every git repository. Markdown files will be displayed as pages in the reader, while other files such as images can be linked from pages. It defaults to `.md`, `.mdx`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif` and `.svg` files. A repository that sets its own `sync.include` replaces this list.

### `defaults.sync.exclude`

**Type:** list of string

The exclude list determines which files will not be downloaded from any git repository, even when the include list selects them. It defaults to `**/README.md`. A repository that sets its own `sync.exclude` adds to this list.

### `defaults.retrieval`

**Type:** object

### `defaults.retrieval.indexable`

**Type:** boolean

Set to `false` to keep every repository's pages out of AI assistant search, the sitemap and search engines, unless a repository's pages are already excluded. Repositories cannot turn it back on.

### `defaults.display`

**Type:** object

### `defaults.display.cover`

**Type:** string or null

A default cover image, as a path relative to each repository's root. Every repository needs that file.
<!-- prettier-ignore-end -->
<!-- /generated -->
