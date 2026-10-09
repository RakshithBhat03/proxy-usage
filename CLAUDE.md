# CPA Usage

## After every change

Rebuild and restart the Docker app container so the running instance reflects the change:

```bash
docker compose up -d --build proxy-usage
```

The image bundles the built app and server, so a plain `docker compose restart` is not enough. Only
recreate the `proxy-usage` service; the `tailscale` sidecar is independent and should stay up.
Confirm the container reports `healthy` (`docker compose ps`) before reporting the change as done.

## Data

`./data` holds the usage history (`usage.sqlite`). Never delete or overwrite it. Use a temporary
`DATA_DIR` for experiments.

## CLIProxyAPI safety

CLIProxyAPI blocks an IP address for 30 minutes after 5 failed management-key attempts, and that
would also cut off the collector. Never send a wrong or empty management key to the real
CLIProxyAPI while testing; use a fake server for failure paths.
