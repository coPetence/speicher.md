---
icon: bug
---

# Troubleshooting

## Port 3000 already in use

By default speicher runs on port 3000. If that port is already in use on your system you can change the port mapping of the `web` service in your docker compose file.
If you are using a reverse proxy you also need to change the port mapping in the reverse proxy configuration.