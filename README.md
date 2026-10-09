# CPA Usage

A focused, CPAMC-styled console for your **CLIProxyAPI** with three pages:

- **Usage**: tokens, cost, speed (TPS), latency, cache efficiency and model/credential breakdowns,
  with granular time ranges (15 minutes to 90 days, calendar ranges, custom from/to to the minute)
  and bucket sizes from 1 minute to 1 week. Includes the model price book with models.dev /
  LiteLLM / OpenRouter sync.
- **Request Monitor**: a live, filterable request stream with per-request detail (timing,
  tokens, cost, response headers, failure evidence), failure breakdowns and credential health.
- **Quota**: every connected credential's quota windows. It shows cards when you have a single
  account per provider and a ledger once you add more, plus the quota windows timeline.

It does not run or bundle a proxy. It reads from your existing stack:

```
browser ──▶ CPA Usage (:18320, Vite) ──proxy──▶ CPA Manager Plus Full Mode (:18317) ──▶ CLIProxyAPI (:8317)
```

CPA Manager Plus keeps the persistent request history, the price book and the CPA management
key. CPA Usage only holds the CPAMP **admin key** you sign in with, in the browser's
localStorage. Every request is same-origin and proxied by Vite, so the UI works on loopback, the
LAN, or a Tailscale hostname without touching CPAMP's CORS settings.

## Run with Docker

```sh
docker compose up -d --build
open http://127.0.0.1:18320                 # or https://cpa-usage.<tailnet>.ts.net
```

Sign in with the CPA Manager Plus admin key (for the local Full Mode stack it is in
`~/.local/share/cpa-manager-plus-docker/secrets/admin.key`).

The container reaches the Manager Server on the Mac's loopback through
`host.docker.internal:18317`. Override with `MANAGER_URL` if yours lives elsewhere.

| Variable        | Default                              | Purpose                                         |
| --------------- | ------------------------------------ | ----------------------------------------------- |
| `PORT`          | `18320`                              | Host port                                       |
| `BIND_ADDR`     | `127.0.0.1`                          | Host interface; `0.0.0.0` also exposes it on the LAN and the Mac's tailnet IP |
| `MANAGER_URL`   | `http://host.docker.internal:18317`  | CPA Manager Plus Manager Server                 |
| `ALLOWED_HOSTS` | (empty)                              | Extra hostnames for Vite's host check           |
| `TS_HOSTNAME`   | `cpa-usage`                          | Machine name of the Tailscale sidecar           |
| `TS_AUTHKEY`    | (none)                               | Tailscale auth key, only needed for the first join |

## Tailscale

The compose file runs a Tailscale sidecar (service `tailscale`, container `proxy-usage-tailscale`)
that joins your tailnet as its own machine and serves the app over HTTPS with Tailscale Serve
(tailnet only, never Funnel):

```
browser on tailnet ──HTTPS──▶ cpa-usage.<tailnet>.ts.net  (container proxy-usage-tailscale, userspace)
                                   │ Serve proxy, compose network
                                   ▼
                     http://proxy-usage:18320  ──▶  Manager Server (host.docker.internal:18317)
```

It uses `tailscale/tailscale:stable` in userspace mode with `TS_AUTH_ONCE` and a health check on
`127.0.0.1:9002/healthz`, and lives in this project so the app and its tailnet node start, stop,
and update together.

- `tailscale/serve.json` is the Serve config. `${TS_CERT_DOMAIN}` is filled in by the container.
- `tailscale/state/` holds the node identity and TLS certificate (gitignored and dockerignored).
  Deleting it orphans the machine; the next start would register `cpa-usage-1`.
- `TS_AUTHKEY` in `.env` is only used the first time the node joins. Without a key,
  `docker compose logs tailscale` prints a login URL to approve once instead.
- The sidecar has its own network namespace and reaches the app by service name, so the app can be
  recreated on its own and `http://127.0.0.1:18320` never depends on Tailscale.
- Vite allows `*.ts.net` hosts, and Serve keeps the original `Host`, so no `ALLOWED_HOSTS` entry is
  needed. The Manager proxy drops the same-origin `Origin` header, so CPAMP's CORS list is untouched.
- Anyone your tailnet ACLs let reach `cpa-usage` can load the UI; the CPAMP admin key is still the
  gate for data.

```sh
docker compose ps                              # both services should be healthy
docker compose logs -f tailscale               # NeedsLogin / auth URL = key expired or used up
docker compose exec tailscale tailscale status # node state from inside the sidecar
docker compose exec tailscale tailscale serve status
docker compose restart tailscale               # after editing tailscale/serve.json
docker compose pull tailscale && docker compose up -d --no-build tailscale   # update Tailscale
```

To remove the node: `docker compose exec tailscale tailscale logout`, then
`docker compose rm -sf tailscale`, delete `tailscale/state/`, and remove the service from
`docker-compose.yml`. If the machine still shows in the admin console, delete it there.

When running the dev server behind `tailscale serve` (HTTPS on 443), set `HMR_CLIENT_PORT=443`.

## Develop

```sh
npm install
npm run dev        # http://127.0.0.1:18320, proxies to MANAGER_URL (default http://127.0.0.1:18317)
npm run build      # type-check + production build
npm run preview    # serve dist/ with the same proxy (what the container runs)
```

Layout:

```
src/
  components/layout   app shell (sidebar, frosted header pill, page transitions) ported from CPAMC
  components/ui       CPAMC primitives (Button, Select, Modal, Sheet, Table, icons…)
  components/kit      shared page vocabulary (PageHeader, ProviderTabs, TimeRangePicker, StatTile…)
  features/usage      Usage page
  features/requests   Request Monitor page
  features/quota      Quota page (+ src/lib/quota for provider parsers and models)
  lib                 API client, analytics types, pricing, time ranges, formatting
  styles              CPAMC theme tokens and layout, plus app.scss
```

The visual design, tokens, shell and several components are ported from the
[CLI Proxy API Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)
(MIT). The data model follows [CPA Manager Plus](https://github.com/seakee/CPA-Manager-Plus).
