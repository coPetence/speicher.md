---
icon: rocket
---

# Set up the instance

Now that Speicher is running, you can set it up in the browser. A new instance has no configuration and no administrator yet, so you start by claiming it.

To start from a prepared `speicher.instance.yaml` instead, see [Seed the configuration from a file](../05-operations/01-seed-configuration.md).

## 1. Claim the instance

Open the instance in your browser. The claim page shows a code, such as `QUIET-HERON-4015`. To approve it, run this in the directory of your `docker-compose.yaml`, with your code:

```sh
docker compose exec web speicher claim QUIET-HERON-4015
```

Within a few seconds, the browser opens the setup page. A code expires after an hour; reload the claim page to get a new one.

:::note
The claimed browser is a temporary administrator. It can configure the instance until you [become the first administrator](#5-become-the-first-administrator) in step 5. After that, the instance can no longer be claimed.
:::

## 2. Add an identity provider

People sign in to Speicher through an identity provider; Speicher itself stores no passwords. On the setup page, choose a provider and follow its guide:

- [Microsoft Entra ID](../02-configuration/01-identity-providers/02-entra-id/index.mdx)
- [OpenID Connect](../02-configuration/01-identity-providers/05-oidc/index.md), for any other provider that supports it, such as Google, Keycloak or Okta
- [GitHub](../02-configuration/01-identity-providers/01-github/index.md)
- [Magic links](../02-configuration/01-identity-providers/04-magic-links/index.md), which sign people in through a link sent by email. They need a [mail transport](../02-configuration/08-mail-transport/index.md).

## 3. Create groups

Repositories grant access to Speicher groups, such as `staff` or `engineering`, not to the groups of an identity provider. In **Groups**, create a group and add its members. A member can be:

- a group of an identity provider, by its id: the object id for an Entra group, `org/team-slug` for a GitHub team
- an email domain, for a magic-link provider
- one person, by email address or by the subject the identity provider sends
- another Speicher group

One group can have members from several identity providers.

## 4. Add a content source

A content source connects Speicher to the Git repositories it draws the content from. On the setup page, choose a source and follow its guide:

- [GitHub](../02-configuration/03-content-sources/01-github/index.md)
- [Plain Git remote](../02-configuration/03-content-sources/02-plain-git-remote/index.md)

## 5. Become the first administrator

Open **Administrator** on the setup page, choose the identity provider and sign in. Speicher saves your account as the first administrator and closes the instance to further claims.

From then on, you open the dashboard at `/-/` and the configuration at `/-/config`. More administrators can be added under **Administrators** in the dashboard.

## Locked out?

- If an administrator is configured but can no longer sign in, add another one on the host. `<provider-id>` is the short id of the identity provider from step 2:

  ```sh
  docker compose exec web speicher admin add --provider <provider-id> --email you@example.com
  ```

- If no administrator is configured, for example after rolling back the configuration, run `docker compose exec web speicher reopen-claim-window` and claim the instance again.

All commands are listed in the [CLI reference](../06-reference/01-cli.md).

**[Continue with publishing your first repository →](03-setup-repository.md)**
