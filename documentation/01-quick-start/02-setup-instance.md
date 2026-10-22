---
icon: rocket
---

# Set up the instance

A new instance has no configuration and no administrator. Whoever can run commands on the host can claim it and then configure the instance in the browser.

To skip the claim and start from a prepared `speicher.instance.yaml` instead, see [Seed the configuration from a file](../05-operations/01-seed-configuration.md).

## 1. Claim the instance

Open the instance in your browser. The claim page shows a code, such as `QUIET-HERON-4015`, and the command to approve it. Run that command on the host, in the directory of your `compose.yml`:

```sh
docker compose exec web speicher claim QUIET-HERON-4015
```

The browser signs in by itself within a few seconds and opens the setup page.

- A code expires after an hour. Reload the claim page to get a new one.
- To list the browsers that are waiting, run `speicher claim` without a code.

:::note
The claimed browser is a temporary administrator. It can configure the instance until the first real administrator signs in, which you do in [step 5](#5-become-the-first-administrator). After that, the instance can no longer be claimed.
:::

## 2. Add an identity provider

People sign in to Speicher through an IDP, so Speicher has no passwords of its own. On the setup page, choose a provider and follow its guide:

- [Microsoft Entra ID](../02-configuration/01-identity-providers/02-entra-id/index.mdx)
- [OpenID Connect](../02-configuration/01-identity-providers/05-oidc/index.md), for any other provider that supports it, such as Google, Keycloak or Okta
- [GitHub](../02-configuration/01-identity-providers/01-github/index.md)
- Magic link, which signs people in through a link sent by email, and needs a mail server

You need the address people sign in through to register Speicher with the provider. The callback URL is:

```
https://<your-host>/api/auth/callback
```

:::caution
The first administrator must sign in through **Microsoft Entra ID or OpenID Connect**. You can add GitHub and magic-link providers as well, but they cannot be used in step 5. If they are all you have, see [Without an OpenID Connect provider](#without-an-openid-connect-provider).
:::

## 3. Create groups

Repositories don't grant access to provider groups directly. They grant it to Speicher's own group names, such as `staff` or `engineering`. In **Groups**, create a name and choose who belongs to it:

- a group from your identity provider, by its id (an Entra group's object id, or `org/team-slug` on GitHub)
- an email domain, for magic-link providers
- individual people, by email address or subject

A name can draw members from several providers. You will use it in your repository's `.speicher.yaml` in the [next guide](03-setup-repository.md).

## 4. Add a content source

A content source is where Speicher reads your repositories from. You can add one now or after step 5. [Publish your first repository](03-setup-repository.md) explains the options.

## 5. Become the first administrator

Open **Administrator** on the setup page, choose your provider and sign in. Speicher records the account you signed in with as the first administrator, and closes the instance to further claims.

From now on, administrators sign in as usual and find the dashboard under `/-/`, for example the configuration at `/-/config`. You can add more administrators there.

## Without an OpenID Connect provider

If you only use magic links, add the first administrator from the host instead of step 5. Add the identity provider first, then run:

```sh
docker compose exec web speicher admin add --provider <provider-id> --email you@example.com
```

`<provider-id>` is the short id you gave the provider in step 2.

## Locked out?

- If an administrator is configured but can no longer sign in, run `speicher admin add` as shown above.
- If no administrator is configured anymore, for example after rolling back the configuration, run `speicher reopen-claim-window` and claim the instance again.

All commands are listed in the [CLI reference](../06-reference/01-cli.md).
