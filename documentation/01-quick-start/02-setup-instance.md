---
icon: rocket
---

# Set up the instance

Now that speicher.md is running, you can set it up in the browser. A new instance has no configuration and no administrator yet, so you start by claiming it.

To start from a prepared `speicher.instance.yaml` instead, see [Seed the configuration from a file](../05-operations/01-seed-configuration.md).

## 1. Add an identity provider

People sign in to speicher.md through an identity provider; speicher.md itself stores no passwords. On the setup page, choose a provider and follow its guide:

- [GitHub](../02-configuration/01-identity-providers/01-github/index.md)
- [Microsoft Entra ID](../02-configuration/01-identity-providers/02-entra-id/index.mdx)
- [OpenID Connect](../02-configuration/01-identity-providers/05-oidc/index.md), for any other provider that supports it, such as Google, Keycloak or Okta
- [Magic links](../02-configuration/01-identity-providers/04-magic-links/index.md), which sign people in through a link sent by email. They need a [mail transport](../02-configuration/08-mail-transport/index.md).

## 2. Create groups

Repositories grant access to speicher.md groups, such as `staff` or `engineering`, not to the groups of an identity provider. In **Groups**, create a group and add its members. A member can be:

- a group of an identity provider, by its id: the object id for an Entra group, `org/team-slug` for a GitHub team
- an email domain, for a magic-link provider
- one person, by email address or by the subject the identity provider sends
- another speicher.md group

One group can have members from several identity providers.

## 3. Add a content source

A content source connects speicher.md to the Git repositories it draws the content from. On the setup page, choose a source and follow its guide:

- [GitHub](../02-configuration/03-content-sources/01-github/index.md)
- [Plain Git remote](../02-configuration/03-content-sources/02-plain-git-remote/index.md)

## 4. Become the first administrator

Open **Administrator** on the setup page, choose the identity provider and sign in. speicher.md saves your account as the first administrator and closes the instance to further claims.

From then on, you open the dashboard and the configuration. More administrators can be added under **Administrators** in the dashboard.

**[Continue with publishing your first repository →](03-setup-repository.md)**
