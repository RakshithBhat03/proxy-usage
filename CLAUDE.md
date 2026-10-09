# Proxy Usage

## After every change

Rebuild and restart the Docker app container so the running instance reflects the change:

```bash
docker compose up -d --build proxy-usage
```

The image bundles the built app, so a plain `docker compose restart` is not enough. Only recreate
the `proxy-usage` service; the `tailscale` sidecar is independent and should stay up. Confirm the
container reports `healthy` (`docker compose ps`) before reporting the change as done.
