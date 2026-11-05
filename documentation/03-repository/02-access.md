---
icon: lock
---

# Access

Who may read a page is decided by the `access` key in the repository's `.speicher.yaml` files, and nowhere else. This page explains how `access` works, how folders narrow it, and how to grant access to individual people and to the public.

## Granting access to a repository

Every repository needs an `access` key in its root `.speicher.yaml`. It lists the groups whose members may read the repository:

```yaml
version: 1
access: [staff]
```

The names are Speicher's own group names, which an administrator maps to groups of your identity provider. See [Create groups](../01-quick-start/02-setup-instance.md#2-create-groups).

The list above is a shorthand. The full form also lets you grant access to [individual people](#granting-access-to-individual-people):

```yaml
version: 1
access:
  groups: [staff]
  users:
    - email: jane.doe@partner.example
      until: 2027-03-31
```

:::caution
A root `.speicher.yaml` without `access` is rejected, and the repository is not published. To unpublish a repository on purpose, delete its root `.speicher.yaml`.
:::

## Narrowing access in folders

A folder can have its own `.speicher.yaml` with an `access` key. It can only **narrow** what the folder inherits, never widen it: a reader needs to be allowed at every level, from the repository root down to the folder. A folder without its own `.speicher.yaml` inherits its parent's access unchanged.

For example:

```
handbook/
├── .speicher.yaml        access: [staff, sales, leadership]
├── onboarding.md
├── sales/
│   ├── .speicher.yaml    access: [sales, leadership]
│   └── pricing.md
└── leadership/
    ├── .speicher.yaml    access: [leadership]
    └── board-minutes.md
```

| Page                          | `staff` | `sales` | `leadership` |
| ----------------------------- | :-----: | :-----: | :----------: |
| `onboarding.md`               |   yes   |   yes   |     yes      |
| `sales/pricing.md`            |         |   yes   |     yes      |
| `leadership/board-minutes.md` |         |         |     yes      |

Someone in several groups sees everything any of their groups may see.

:::caution
A folder cannot add a group that its parent did not grant. If the root grants `[staff]` and a folder says `access: [sales]`, nobody can read that folder, and the sync reports _no readers specified_. Grant every group at the root, then narrow it down in the folders.
:::

## Granting access to individual people

Under `users`, you can grant access to a person directly, for example an external collaborator who is in none of your groups. Every individual grant needs an expiry date in `until`:

```yaml
version: 1
access:
  groups: [staff]
  users:
    # By email address
    - email: jane.doe@partner.example
      until: 2027-03-31

    # By the identity provider's subject id, which needs a note saying who it is
    - provider: entra
      subject: 4f6c1a9e-2b7d-4c1e-9a3f-0d5e8b7c6a21
      note: Jane Doe, external auditor
      until: 2027-03-31
```

Each grant names a person in exactly one of two ways:

- **`email`**: matched against the email address the identity provider reports when the person signs in. If the provider has a directory configured, Speicher looks the address up during each sync and stores the person's subject id instead.
- **`subject`** with a **`note`**: the person's permanent id at the identity provider. It never changes and is never reused for someone else, so it is the safer choice. The note records who it is, since the id itself means nothing to a reader.

**`provider`** names the identity provider the person signs in with, by the short id it has in the instance configuration. You can leave it out when the instance has only one provider, or when an administrator has set `auth.default_provider`. Otherwise the grant is rejected.

**`until`** is a date such as `2027-03-31`. The grant is valid until the end of that day (UTC). After that, Speicher syncs the repository again and drops the grant.

## Making pages public

Publishing a page to the internet takes two steps, and both are required:

1. An administrator allows the repository to be public by listing it under `public.repos` in the instance configuration:

   ```yaml
   public:
     repos: [acme/handbook]
   ```

2. The repository grants access to `public`, a reserved group that everyone has, including visitors who are not signed in:

   ```yaml
   version: 1
   access: [public, staff]
   ```

If the repository names `public` without being listed under `public.repos`, the configuration is rejected.

Folders narrow public access like any other group. To keep one folder internal, grant both at the root and narrow the folder:

```
handbook/
├── .speicher.yaml        access: [public, staff]
├── index.md              everyone
└── internal/
    ├── .speicher.yaml    access: [staff]
    └── roadmap.md        staff only
```

## Maintainers

The root `.speicher.yaml` can name the maintainers of a repository. Maintainers can see the repository's sync status and the problems its last sync ran into. They get no other dashboard access, and no access to the content itself. To read the pages, they need to be in `access` as well.

```yaml
version: 1
access: [staff]

maintainers:
  groups: [docs-team]
  users:
    - email: lead@acme.example
      until: 2027-03-31
```

`maintainers` always uses the full form with `groups` and `users`, and it cannot name `public`.

## Images and other files

An image or other file is readable by the people who may read the **folder it is stored in**, not the page that links to it. If a page in `onboarding/` shows an image stored in `sales/`, readers who are not allowed into `sales/` see a broken image. Keep files next to the pages that use them.

## Frontmatter cannot change access

A page's frontmatter has no say in who may read it. A page whose frontmatter contains `access`, `maintainers`, `groups` or `users` is rejected, and its folder is not updated until the key is removed. To restrict a single page, move it into a folder with its own `.speicher.yaml`.

## When a configuration is rejected

A rejected `.speicher.yaml` never makes content more visible. When the sync rejects a configuration, for example because of an unknown group name or a missing `until`, the affected part of the repository is not updated. Readers keep seeing what was published there before. If the root configuration is rejected, none of the commit's changes are published.

The problems are listed on the repository's **Sync status** page in the dashboard.

## All `access` keys

The full list of `.speicher.yaml` keys is in the [repository configuration reference](../06-reference/04-repository-configuration.md).

<!-- generated: schema speicher#/properties/access -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `access` | list of string or object |  |  | Who may read the pages at this level. Required in the root `.speicher.yaml`. In a folder, it can only narrow what the folder inherits: a reader must be allowed at every level from the root down. |
| `access.groups` | list of string |  |  | Group names whose members may read. Each name must be a group configured on the instance, or `public` if the instance lists this repository under `public.repos`. |
| `access.users` | list of object |  |  | Individual people who may read, each with an expiry date. |
| `access.users[]` | object |  |  | One person, named by `email` or by `subject` with a `note`. Set exactly one of: `subject` + `note`, `email`. |
| `access.users[].provider` | string |  |  | Short id of the identity provider the person signs in with. Can be left out when the instance has one provider or sets `auth.default_provider`. |
| `access.users[].subject` | string |  |  | The person's permanent id at the identity provider, the value of its subject claim. It never changes and is never reused. For a magic-link provider, it is the email address. Needs a `note`. |
| `access.users[].email` | string (email) |  |  | The person's email address, matched against the address the identity provider reports at sign-in. If the provider has a directory, it is resolved to the person's subject id during each sync. |
| `access.users[].note` | string |  |  | Who this grant is for, such as a name and role. Required with `subject`. Up to 200 characters. |
| `access.users[].until` | string (date) |  | yes | Date the grant ends, as `YYYY-MM-DD`. It is valid until the end of that day (UTC). The repository then syncs again and the grant is dropped. |
<!-- prettier-ignore-end -->
<!-- /generated -->
