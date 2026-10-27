---
icon: send
---

# Mail transport

Speicher sends email through an SMTP server you provide. It has no mail server of its own.

Speicher uses it to send sign-in links for [magic-link providers](../01-identity-providers/04-magic-links/index.md). A magic-link provider cannot be added until a mail transport is configured.

## 1. Get SMTP credentials

You need the following from your mail provider or your organization's mail server:

- the SMTP host, for example `smtp.example.com`
- the port, usually `587` or `465`
- a username and password, unless the server accepts mail without signing in
- an address Speicher may send from, for example `docs@example.com`

On port `465`, Speicher connects with TLS from the start. On any other port, it connects unencrypted and switches to TLS with STARTTLS when the server offers it.

:::note
Many providers only accept mail from addresses or domains you have verified with them. Use a sender address the provider allows, or emails will be rejected.
:::

## 2. Configure it in Speicher

In the dashboard, go to **Configuration → Mail transport** and fill in:

- **SMTP host** and **Port**
- **Username** and **Password**
- **From**: optional, the sender, as an address or as `Name <address>`, for example `Docs <docs@example.com>`
- **Reply-to**: optional, where replies go if not to the sender

Then select **Check the connection**. Speicher connects to the server and signs in, and shows **Connected and signed in** (or **Connected** without a username) if that worked, or the error if it did not. No email is sent.

<!-- screenshot: the Mail transport page with "Connected and signed in" -->

Save the configuration. Speicher uses the new settings from the next email it sends, without a restart.

The same settings in the instance configuration file look like this:

```yaml
mail:
  host: smtp.example.com
  port: 587
  username: docs@example.com
  password: ${SMTP_PASSWORD}
  from: Docs <docs@example.com>
  reply_to: support@example.com
```

## Keeping the password out of the configuration

You can enter the password directly, which stores it in the database, or as a reference to an environment variable, such as `${SMTP_PASSWORD}`. Set the variable for both the web and the worker process, because both read the configuration. With the Docker Compose file from the [quick start](../../01-quick-start/01-self-hosted.md), add it under `environment:` in the shared `x-speicher` block, and restart.

The name must not start with `SPEICHER_`, which is reserved for Speicher's own settings.

## When sending fails

Speicher does not queue or retry email. If the server refuses a message or cannot be reached, the message is dropped and the error is logged as `could not send mail`, with the reason:

```sh
docker compose logs web worker | grep "could not send mail"
```

## All settings

<!-- generated: schema instance#/properties/mail -->
<!-- prettier-ignore-start -->
| Key | Type | Default | Required | Description |
| --- | --- | --- | --- | --- |
| `mail` | object |  |  | The SMTP server Speicher sends sign-in links for magic-link providers through. Required before a magic-link provider can be added. |
| `mail.host` | string |  | yes | The SMTP server's host name, for example `smtp.example.com`. |
| `mail.port` | integer | `587` |  | The SMTP port. On `465` Speicher connects with TLS from the start; on any other port it switches to TLS with STARTTLS when the server offers it. |
| `mail.username` | string |  |  | The username to sign in to the SMTP server with. Leave it out if the server accepts mail without signing in. |
| `mail.password` | string |  |  | The password for `username`. Can be a reference to an environment variable, such as `${SMTP_PASSWORD}`. |
| `mail.from` | string |  |  | The sender of every email, as an address or as `Name <address>`. Use an address your SMTP provider allows you to send from. Defaults to the brand name with `username` when that is an address, or with `noreply@` the host of `SPEICHER_PUBLIC_URL` otherwise. Example: `Docs <docs@example.com>`. |
| `mail.reply_to` | string |  |  | Where replies go, if not to the sender. Optional. |
<!-- prettier-ignore-end -->
<!-- /generated -->
