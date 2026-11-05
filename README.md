<div align="center">
  <img src=".github/assets/banner.svg" alt="speicher.md" width="600">
  <p><strong>Git-native · Markdown · Per-folder access control · SSO (OIDC / Entra ID / GitHub) · MCP server · Hybrid search · Self-hosted</strong></p>
  <p>
    <a href="https://speicher.md">Website</a> ·
    <a href="https://docs.speicher.md/quick-start/self-hosted">Start self-hosting</a> ·
    <a href="https://docs.speicher.md">Docs</a>
  </p>
</div>

## What is speicher.md?

speicher.md is a self-hosted documentation platform for sharing docs with people outside your team (customers, partners, contractors) without risking a leak. Your Markdown lives in git, access rules live next to it, and every reader (human or AI agent) sees exactly the pages they're allowed to see.

## Try it yourself

```bash
curl -fsSL \
  https://speicher.md/install.sh | bash
```

The installation script creates a directory `speicher/` in your home directory, downloads the latest release of speicher.md, and starts it with Docker Compose. It also generates a random database password and writes it to a `.env` file in the same directory.

When the script finishes, open [http://localhost:32168](http://localhost:32168) in your browser, or the address of your server.

**[Continue with setting up the instance →](https://docs.speicher.md/quick-start/setup-instance)**

Additional configuration options:

- [Manual installation](https://docs.speicher.md/quick-start/self-hosted-manual): If you prefer to set up the instance without the installation script
- [Reverse proxy and TLS](https://docs.speicher.md/operations/reverse-proxy-and-tls): If you want to run the instance on a server with HTTPS
- [Full documentation](https://docs.speicher.md)

## Why speicher.md?

Most wikis are not designed for protecting your content with fine-grained access control, while still being easy to share with large groups of people.

speicher.md is designed specifically around sharing content with groups of people or agents. It relies on identity providers to manage access, so you can use your existing accounts and groups.

Some things that make speicher.md unique:

- **Git is the source of truth**: Content gets written in your editor, can be versioned and reviewed in your git workflow, and is served by speicher.md.
- **Permissions are code**: ACLs are defined in `.speicher.yaml` files in the repository next to the content. This makes them versioned and reviewable, just like the content itself.
- **Designed for AI agents**: speicher.md has a built-in MCP server, so your users can connect their own AI assistants to your documentation, and the assistant sees exactly the pages the user is allowed to see.

## Maintainers & contact

speicher.md is built and maintained by [coPetence GmbH](https://copetence.de), a software consultancy based in Germany. We are happy to help with your self-hosted instance, commercial licensing, or custom features and integrations.

Just write us an email at: [speicher-md@copetence.de](mailto:speicher-md@copetence.de).

## License

speicher.md is source-available under the [Business Source License 1.1](LICENCE).

- **Free for non-production use**: You can run speicher.md for free in a non-production environment, e.g. for testing or evaluation.
- **Free in production** for organisations with fewer than 10 people (more details in the [license](LICENCE)).
- **Commercial license**: For production use in larger organisations, please contact us for a commercial license.
