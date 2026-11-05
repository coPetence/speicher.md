---
icon: shield
---

# Administrators

Administrators run the instance. They configure it, see the sync status of every repository and look into failed syncs.

Being an administrator does not let anyone read content. Administrators see the same pages as everyone else, decided by each repository's `access`. To read a repository, an administrator needs to be in its `access` like any other reader.

## What administrators can do

Administrators see these pages in the dashboard under `/-/`:

- **Set up**, the first-run overview at `/-/setup`
- **Configuration** at `/-/config`, with every setting of the instance
- **Sync status** at `/-/status`, for every repository
- **Dead jobs** at `/-/dead-jobs`, the syncs that failed for good

Everyone else gets a "not found" page there, except [maintainers](../../03-repository/02-access.md#maintainers), who see the sync status of their own repositories.

Access with an MCP token never counts as administrator access, even when the token belongs to an administrator.

## Adding administrators

You can name administrators individually, or make a whole group an administrator group.

**People:** in **Configuration → Administrators**, add a person by email address, or by subject with a note saying who it is.

**Groups:** open the group in **Configuration → Groups** and turn on **Administrator access**. Everyone in the group is then an administrator.

In the configuration file, both are under `admins`:

```yaml
admins:
  groups: [platform-admins]
  users:
    - provider: entra
      email: jane@acme.example
    - provider: github
      subject: '583231'
      note: Sam Lee, platform team
```

Each group must be one of the instance's [groups](../../01-quick-start/02-setup-instance.md#2-create-groups), and each person needs a `provider`, unless the instance has only one provider or sets `auth.default_provider`.

From the host, you can also add a person with the CLI:

```sh
docker compose exec web speicher admin add --provider entra --email jane@acme.example
```

## Nobody can lock everyone out

speicher.md refuses to save a configuration that leaves nobody as administrator. That happens when there is no person under `admins.users`, and every group under `admins.groups` has no members, because it is not mapped to a provider group or a person.

:::note
The check only looks at the configuration. It cannot tell whether an administrator can still sign in, for example after leaving the company. Keep at least two administrators.
:::

## The first administrator

A new instance has no administrator. The first one signs in during setup, as described in [Set up the instance](../../01-quick-start/02-setup-instance.md#4-become-the-first-administrator).

## Locked out

If no administrator can sign in anymore, use the CLI on the host:

- If an administrator is configured but cannot sign in, add yourself with `speicher admin add`, as shown above.
- If no administrator is configured at all, for example after rolling back the configuration, run `speicher reopen-claim-window` and [claim the instance](../../01-quick-start/04-self-hosted-manual.md#4-claim-the-instance) again.

## Administrators of one repository

To let a team look after its own repository without making them administrators of the whole instance, name them as [maintainers](../../03-repository/02-access.md#maintainers) in the repository's `.speicher.yaml`.

## All settings

<!-- generated: schema instance#/properties/admins -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `admins` | object |  |  | Who administers this instance: the people and groups who can open the configuration and sync status of every repository under `/-/`. Administrators get no read access to content from this. A configuration that leaves nobody as administrator cannot be saved. |
| `admins.groups` | list of string |  |  | Groups whose members are administrators. Each must be a group defined under `groups`, and at least one administrator group needs members unless `users` names someone. |
| `admins.users` | list of object |  |  | Individual administrators, each named by `email`, or by `subject` with a `note`. |
| `admins.users[]` | object |  |  | Set exactly one of: `subject` + `note`, `email`. |
| `admins.users[].provider` | string |  |  | Short id of the identity provider the person signs in with. Can be left out when the instance has one provider or sets `auth.default_provider`. |
| `admins.users[].subject` | string |  |  | Value of the provider's subject_claim. For a magic-link provider the subject IS the lowercased email address. |
| `admins.users[].email` | string (email) |  |  | The person's email address, matched at every request against the address the identity provider reports at sign-in. Use `subject` for a grant that should survive a change of address. |
| `admins.users[].note` | string |  |  | Who this entry is for, such as a name and role. Required with `subject`. |
| `admins.users[].until` | string (date) |  |  | Optional for admins; mandatory for content grants. |
<!-- prettier-ignore-end -->
<!-- /generated -->
