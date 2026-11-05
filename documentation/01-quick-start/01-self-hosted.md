---
icon: server
title: Self-hosting
---

# Self-hosting with Docker Compose

## Prerequisites

- **Docker** with the **Compose plugin**. [How to install](https://docs.docker.com/engine/install/)
- **Port 32168** is not in use on your machine. If it is taken, do [use a different port](../reference/troubleshooting#port-32168-already-in-use)

## Install speicher.md

```bash
curl -fsSL \
  https://speicher.md/install.sh | bash
```

The installation script creates a directory `speicher/` in your home directory, downloads the latest release of speicher.md, and starts it with Docker Compose. It also generates a random database password and writes it to a `.env` file in the same directory.

When the script finishes, open [http://localhost:32168](http://localhost:32168) in your browser, or the address of your server.

**[Continue with setting up the instance →](./setup-instance)**

---

Other Links:

- [Manual installation](./self-hosted-manual): If you prefer to set up the instance without the installation script
- [Reverse proxy and TLS](../operations/reverse-proxy-and-tls): If you want to run the instance on a server with HTTPS
