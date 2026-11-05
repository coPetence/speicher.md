---
icon: bug
---

# Troubleshooting

## Port 32168 already in use

By default speicher.md is published on port 32168 of the host. If that port is already in use on your system, change the host side of the port mapping of the `web` service in your docker compose file, for example `'8080:3000'`, and update `SPEICHER_PUBLIC_URL` to match. Keep `3000` on the right: that is the port inside the container.
If you are using a reverse proxy you also need to change the port mapping in the reverse proxy configuration.

---

## Locked out?

- If an administrator is configured but can no longer sign in, add another one on the host. `<provider-id>` is the short id of the identity provider from step 2:

  ```sh
  docker compose exec web speicher admin add --provider <provider-id> --email you@example.com
  ```

- If no administrator is configured, for example after rolling back the configuration, run `docker compose exec web speicher reopen-claim-window` and claim the instance again.

---

## Why is my README.md not published?

They are excluded by default. To change which files are ingested set [`sync.include` and `sync.exclude`](../03-repository/01-speicher-yaml.md#choosing-files-with-sync) in `.speicher.yaml` or set it as a **Repository Default** in the configuration.
