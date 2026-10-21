---
icon: house
---

# Speicher documentation

Speicher publishes the Markdown files in your git repositories as a documentation site. People sign in with the accounts they already have, such as Microsoft Entra ID, Google or GitHub, and each page is shown only to the people its repository grants access to. AI assistants can search and read the same pages, with the same permissions, through Speicher's MCP server.

## Get started

1. [Self-host Speicher](01-quick-start/01-self-hosted.md) with Docker Compose.
2. [Set up the instance](01-quick-start/02-setup-instance.md): claim it, add an identity provider and become its administrator.
3. [Publish your first repository](01-quick-start/03-setup-repository.md).

## Write documentation

- [The `.speicher.yaml` file](03-repository/01-speicher-yaml.md) chooses which files are published and how they are shown.
- [Access](03-repository/02-access.md) explains who can read what, down to single folders.
- [Markdown syntax](03-repository/03-markdown-syntax.md) lists everything you can write, from callouts and wikilinks to MDX components.

## Configure the instance

- **Sign-in:** [Microsoft Entra ID](02-configuration/01-identity-providers/02-entra-id/index.mdx), [OpenID Connect](02-configuration/01-identity-providers/05-oidc/index.md), [GitHub](02-configuration/01-identity-providers/01-github/index.md) and [magic links](02-configuration/01-identity-providers/04-magic-links/index.md)
- **Content sources:** [GitHub App](02-configuration/03-content-sources/01-github/index.md) and [plain git remote](02-configuration/03-content-sources/02-plain-git-remote/index.md)
- **People:** [administrators](02-configuration/06-administrators/index.md) and [public access](02-configuration/04-public-access/index.md)
- **Appearance:** [branding](02-configuration/05-branding/index.md) and [reading experience](02-configuration/12-reading-experience/index.md)
- **Services:** [asset storage](02-configuration/07-asset-storage/index.mdx) and [mail transport](02-configuration/08-mail-transport/index.md)

## Run it in production

- [Reverse proxy and TLS](05-operations/04-reverse-proxy-and-tls.md) with Caddy or nginx.

## Reference

- [CLI](06-reference/01-cli.md)
- [Environment variables](06-reference/02-environment-variables.md)
- [Instance configuration](06-reference/03-instance-configuration.md)
- [Repository configuration](06-reference/04-repository-configuration.md)
- [Frontmatter](06-reference/05-frontmatter.md)
- [MCP tools](06-reference/06-mcp-tools.md)
