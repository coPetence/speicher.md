---
icon: key-round
---

# OpenID Connect

You can use any identity provider that supports OpenID Connect, such as Google, Keycloak, Authentik or Okta. People then sign in with their account at that provider. This page uses Google as the example.

For Microsoft Entra ID, use the [Entra ID provider](../02-entra-id/index.mdx) instead. It sets the Entra-specific details for you.

## 0. Before you start

Speicher reads three things from the sign-in token:

| Claim   | Default  | Used for                                                                                 |
| ------- | -------- | ---------------------------------------------------------------------------------------- |
| Subject | `sub`    | The permanent id of the person. Access granted to a subject never moves to someone else. |
| Email   | `email`  | Matching access granted by email address.                                                |
| Groups  | `groups` | Matching the person to your groups in Speicher. Optional.                                |

Not every provider sends groups. **Google sends none.** With Google, you add people to a Speicher group one by one, by email address or subject, instead of mapping a Google group. A provider without groups works fine otherwise.

An OpenID Connect provider can also sign in the [first administrator](../../../01-quick-start/02-setup-instance.md#4-become-the-first-administrator) of a new instance.

## 1. Register Speicher with your provider

Every provider asks for the address it sends people back to after they sign in. For Speicher this is:

```
https://<your-host>/api/auth/callback
```

Speicher builds it from `SPEICHER_PUBLIC_URL` when that is set, and otherwise from the address the request came in on.

Speicher asks for the scopes `openid profile email`, and signs in with the authorization code flow and PKCE.

### Example: Google

1. In the [Google Cloud console](https://console.cloud.google.com/), select or create a project.
2. Set up the **OAuth consent screen**. Choose **Internal** if only people in your Google Workspace organization should be able to sign in. **External** lets any Google account sign in.
3. Under **Clients** (or **APIs & Services → Credentials**), create an **OAuth client ID** of type **Web application**.
4. Add the callback URL above under **Authorized redirect URIs**.
5. Copy the **Client ID** and **Client secret**.

<!-- screenshot: Google Cloud console, OAuth client with the authorized redirect URI filled in -->

:::caution
With **External**, anyone with a Google account can sign in. They can only read what access rules grant them, but if you grant access by email domain or to large groups, check who that includes.
:::

## 2. Add the provider in Speicher

In the Speicher dashboard, go to **Configuration → Identity Providers**, add a provider and choose **OpenID Connect**. Fill in:

- **Issuer URL**: the address of your provider's OpenID Connect server. For Google it is `https://accounts.google.com`. Speicher reads the rest of the provider's settings from `<issuer>/.well-known/openid-configuration`.
- **Client id** and **Client secret** from step 1.
- **Display name**: what the sign-in button says, for example `Google`.

Leave the claim fields empty to use the defaults from the table above. Change them only if your provider sends the subject, email or groups under a different name.

<!-- screenshot: Speicher OpenID Connect provider form with Google's issuer, client id and secret -->

Save the configuration. The provider now appears on the sign-in page.

The same provider in the instance configuration file looks like this:

```yaml
auth:
  providers:
    google:
      type: oidc
      display_name: Google
      issuer: https://accounts.google.com
      client_id: 1234567890-abc.apps.googleusercontent.com
      client_secret: ${GOOGLE_CLIENT_SECRET}
```

## 3. Optional settings

### Email domains

If you list email domains, the sign-in page offers this provider only to people who enter an address at one of them. Providers without domains are shown to everyone. This keeps the sign-in page short when you have several providers, for example Google for your staff and magic links for guests.

### Session lifetime

A sign-in stays valid for 8 hours by default. Groups are read from the sign-in token, so when someone leaves a group at the provider, Speicher only notices at their next sign-in. A shorter session lifetime makes that happen sooner.

```yaml
auth:
  providers:
    google:
      type: oidc
      issuer: https://accounts.google.com
      client_id: 1234567890-abc.apps.googleusercontent.com
      client_secret: ${GOOGLE_CLIENT_SECRET}
      domains: [example.com]
      session_ttl: 4h
```

## Other providers

Speicher works with any provider that publishes OpenID Connect discovery metadata at `<issuer>/.well-known/openid-configuration`. The steps are the same as for Google: register a web application with the callback URL, then copy the issuer, client id and client secret into Speicher.

:::note
The issuer must name one tenant or realm. Multi-tenant issuers, such as Entra's `common` or `organizations`, are refused, because Speicher could not tell which organization a token came from.
:::

## All settings

<!-- generated: schema instance#/$defs/oidcProvider auth.providers.<id> -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `auth.providers.<id>` | object |  |  |  |
| `auth.providers.<id>.type` | `oidc` | `oidc` |  | Selects the OpenID Connect provider. Use it for any provider that supports OpenID Connect, such as Google, Keycloak or Okta. |
| `auth.providers.<id>.display_name` | string |  |  | The name the sign-in page shows for this provider, for example `Google`. Defaults to the provider's id. |
| `auth.providers.<id>.issuer` | string (uri) |  | yes | The address of the provider's OpenID Connect server, for example `https://accounts.google.com`. Speicher reads the provider's settings from `<issuer>/.well-known/openid-configuration`, and refuses an issuer that does not name a single tenant or realm. |
| `auth.providers.<id>.client_id` | string |  | yes | The client id of the application you registered for Speicher at the provider. |
| `auth.providers.<id>.client_secret` | string |  |  | The client secret of that application. Leave it out only if the provider registered Speicher as a public client. |
| `auth.providers.<id>.subject_claim` | string | `sub` |  | The claim in the sign-in token that holds the person's permanent id. Most providers use `sub`. |
| `auth.providers.<id>.groups_claim` | string | `groups` |  | The claim in the sign-in token that lists the person's groups. Without it, or if the provider sends none (such as Google), the person belongs to no provider groups and can only be added to groups by email or subject. |
| `auth.providers.<id>.email_claim` | string | `email` |  | The claim in the sign-in token that holds the person's email address. Access granted by email is matched against it. |
| `auth.providers.<id>.domains` | list of string |  |  | Offer this provider only for addresses at these domains. Absent means it is offered for every address. |
| `auth.providers.<id>.session_ttl` | string | `8h` |  | How long a sign-in stays valid. Groups are read only at sign-in, so a removed group membership keeps working until the session ends. |
| `auth.providers.<id>.connection_idle_ttl` | string | `30d` |  | If you have a directory configured, this is how long a connection persists while not used. Without a directory, a connection ends with `session_ttl`. |
| `auth.providers.<id>.directory` | object |  |  | Optional read access to the provider's directory. Speicher uses it to resolve email grants to people, count group members and notice people who have left. |
| `auth.providers.<id>.directory.type` | `graph`, `github` |  | yes | graph = Microsoft Graph; github = GitHub organisation API |
| `auth.providers.<id>.directory.tenant_id` | string |  |  | graph: the id of the Entra tenant to read. |
| `auth.providers.<id>.directory.client_id` | string |  |  | graph. Usually a separate app registration from the delegated-flow client: application permissions such as User.Read.All need admin consent. |
| `auth.providers.<id>.directory.client_secret` | string |  |  | graph: the client secret of the directory application. |
| `auth.providers.<id>.directory.app_id` | string |  |  | github. The App id for the directory GitHub App |
| `auth.providers.<id>.directory.private_key` | string |  |  | github. The PEM of the App named |
| `auth.providers.<id>.directory.webhook_secret` | string |  |  | github. This secret is used to sign the webhook deliveries of the App. |
| `auth.providers.<id>.directory.cache_ttl` | string | `1h` |  | How long directory answers are cached before Speicher asks again. |
<!-- prettier-ignore-end -->
<!-- /generated -->
