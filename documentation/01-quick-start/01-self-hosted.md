---
icon: server
title: Self-hosting
---

# Self-hosting with Docker Compose

## Prerequisites

- **Docker** with the **Compose plugin**. [How to install](https://docs.docker.com/engine/install/)
- **Port 3000** is not in use on your machine. If it is taken, do [use a different port](../reference/troubleshooting#port-3000-already-in-use)

> [!info] Installation script
>
> ```bash
> curl https://raw.githubusercontent.com/coPetence/speicher.md/refs/heads/documentation/deploy/install.sh | bash
> ```

The installation script creates a directory `speicher/` in your home directory, downloads the latest release of speicher.md, and starts it with Docker Compose. It also generates a random database password and writes it to a `.env` file in the same directory.

When the script finishes, open [http://localhost:3000](http://localhost:3000) in your browser, or the address of your server.

**[Continue with setting up the instance →](02-setup-instance.md)**

---

Other Links:

- [Manual installation](01-self-hosted-manual.md): If you prefer to set up the instance without the installation script
- [Reverse proxy and TLS](../05-operations/04-reverse-proxy-and-tls.md): If you want to run the instance on a server with HTTPS
