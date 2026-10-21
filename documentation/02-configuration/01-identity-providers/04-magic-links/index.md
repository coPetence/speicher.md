# Magic links

With a magic-link provider, people sign in with their email address instead of an account at an identity provider. Speicher emails them a link, and opening the link signs them in. This suits guests and external collaborators who have no account in your organization's identity provider.

## 0. Before you start

- Magic links need a [mail transport](../../08-mail-transport/index.md). Configure it first. Speicher refuses a magic-link provider while no mail transport is configured.
- A magic-link provider cannot sign in the [first administrator](../../../01-quick-start/02-setup-instance.md#5-become-the-first-administrator) of a new instance. If magic links are your only provider, add the first administrator with `speicher admin add` instead, as described in [Without an OpenID Connect provider](../../../01-quick-start/02-setup-instance.md#without-an-openid-connect-provider).

## How signing in works

1. On the sign-in page, the person chooses the provider, enters their email address and selects **Email me a link**.
2. Speicher emails a link that can be used once and expires after 15 minutes.
3. The person opens the link in the same browser and is signed in.

The page always answers "If this address is registered, a sign-in link has been sent", whether or not a link was sent. That way, nobody can find out which addresses have access by trying them.

## Who receives a link

Speicher only sends a link to an address that already has access to something. The address must be granted at least one page, directly or through a group, or be a maintainer of a repository or an administrator. For everyone else, nothing is sent.

You grant access to magic-link users the same way as to anyone else:

- **By address**, in a repository's `access`, as described in [Access](../../../03-repository/02-access.md#granting-access-to-individual-people).
- **By address or domain in a group.** A group can include everyone with an address at a domain, for example everyone at `partner.example`:

```yaml
groups:
  partners:
    - provider: guests
      domain: partner.example
      note: Everyone at our partner agency
    - provider: guests
      email: jane@freelance.example
      note: Jane Doe, freelance editor
```

:::caution
Never use the domain of a public email service, such as `gmail.com`. Anyone who can receive mail at that domain would get access.
:::

For a magic-link provider, a person's subject is their email address in lowercase. Granting access by `subject` or by `email` therefore means the same person.

Requests are limited to 5 links per address and 20 requests per IP address, each per 15 minutes. Requests beyond that are ignored without notice.

## 1. Add the provider in Speicher

In the dashboard, go to **Configuration → Identity Providers**, add a provider and choose **Magic link (email)**. Give it a short id, for example `guests`, and a **Display name**, which is what the sign-in page shows, for example `Email link`.

<!-- screenshot: the Magic link provider form -->

Save the configuration. The provider now appears on the sign-in page.

The same provider in the instance configuration file looks like this:

```yaml
auth:
  providers:
    guests:
      type: magic-link
      display_name: Email link
```

## 2. Optional settings

### Link lifetime

A link expires 15 minutes after it was sent. Set `token_ttl` to change that.

### Same browser

By default, a link only works in the browser it was requested from. Someone who requests a link on their laptop and opens the email on their phone is refused and has to request a new link on the phone. This prevents a link from being used by someone who intercepted the email.

To allow opening the link in any browser, set `same_browser: false`.

:::note
The browser remembers that it requested a link for one hour. With `same_browser` on, keep `token_ttl` at one hour or less.
:::

### Session lifetime

A sign-in stays valid for 30 days by default. Set `session_ttl` to change that.

```yaml
auth:
  providers:
    guests:
      type: magic-link
      display_name: Email link
      token_ttl: 30m
      session_ttl: 7d
      same_browser: false
```

## All settings

<!-- generated: schema instance#/$defs/magicLinkProvider auth.providers.<id> -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `auth.providers.<id>` | object |  |  |  |
| `auth.providers.<id>.type` | `magic-link` |  | yes | Selects the magic-link provider, which signs people in with a link sent to their email address. Needs `mail`. |
| `auth.providers.<id>.display_name` | string |  |  | The name the sign-in page shows for this provider, for example `Email link`. Defaults to the provider's id. |
| `auth.providers.<id>.token_ttl` | string | `15m` |  | How long a sign-in link stays valid after it is sent. A link can be used only once. |
| `auth.providers.<id>.session_ttl` | string | `30d` |  | How long a sign-in stays valid. |
| `auth.providers.<id>.same_browser` | boolean | `true` |  | Whether a link only works in the browser it was requested from. Turn it off to let people request a link on one device and open it on another. |
<!-- prettier-ignore-end -->
<!-- /generated -->
