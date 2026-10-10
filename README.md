# CPA Usage

A self-hosted usage dashboard for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
It collects every request CLIProxyAPI serves, keeps the history in a local SQLite database, and
shows it on three pages:

- **Usage**: tokens, cost, speed (TPS), latency, cache efficiency, and model, credential, provider
  and API-key breakdowns. Time ranges go from 15 minutes to all time, including calendar ranges and
  custom from/to down to the minute, with buckets from 1 minute to 1 week. It includes a model price
  book that syncs from models.dev, LiteLLM and OpenRouter.
- **Request Monitor**: a live, filterable request stream with per-request detail (timing, tokens,
  cost, response headers, failure evidence), failure breakdowns and credential health.
- **Quota**: quota windows for every connected credential, with a timeline and per-window usage
  history.

It is a single Node service with no external database and no other management server to run.

## How it works

```
                 usage queue (RESP SUBSCRIBE, HTTP fallback)
CLIProxyAPI :8317 ───────────────────────────────────────────▶ CPA Usage :18320 ◀── browser
        ▲                                                     │  SQLite (./data)
        └──── auth-files, api-call (forwarded with your key) ─┘
```

Since v6.10, CLIProxyAPI no longer keeps usage statistics itself. Instead it publishes one record per
request to a short-lived usage queue. CPA Usage subscribes to that queue with the management key and
stores each record. Subscribing doesn't take records from the queue, so it can run alongside other
collectors.

The Quota page reads credentials and live provider quota through CLIProxyAPI's own management API
(`auth-files`, `api-call`). The server forwards those calls with the key you signed in with.

## Requirements

- CLIProxyAPI v6.10.8 or newer (v8 recommended), with a management key set.
- Docker, or Node.js 22.18+ to run without Docker.

The relevant parts of CLIProxyAPI's `config.yaml` (v8 layout; older versions use a top-level
`remote-management:` block and top-level usage keys):

```yaml
management:
  secret-key: "your-management-key"   # or set MANAGEMENT_PASSWORD
  # Needed when CLIProxyAPI sees CPA Usage as a remote client (some Docker setups).
  allow-remote: true

observability:
  usage:
    # CPA Usage turns this on if it is off (AUTO_ENABLE_USAGE_STATISTICS=false to opt out).
    usage-statistics-enabled: true
    # How long queued records survive (seconds, max 3600). Raise it if CPA Usage may be down a while.
    redis-usage-queue-retention-seconds: 60
```

## Quick start (Docker)

```sh
cp .env.example .env && chmod 600 .env   # set CPA_MANAGEMENT_KEY
mkdir -p data web
docker compose up -d --build
open http://127.0.0.1:18320
```

Sign in with your CLIProxyAPI management key, the same key the
[CLI Proxy API Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)
uses. History starts from the moment the collector first connects.

The container reaches CLIProxyAPI on the Docker host through `host.docker.internal:8317`. Set
`CPA_URL` if yours lives elsewhere. On Linux the container runs as uid 1000, so `./data` must be
writable by that user.

### Updating without interrupting the collector

Restarting the container pauses the collector. Requests that arrive while it is down are only
recovered if they are still in CLIProxyAPI's usage queue (`redis-usage-queue-retention-seconds`),
so keep restarts for backend changes:

- **UI changes:** `npm run publish:ui` builds the UI into `./web`, which the container serves
  (`UI_DIR`). The new UI is live on the next page load and the server keeps running. Until `./web`
  holds a build, the UI baked into the image is served.
- **Server changes** (`server/`, `shared/`, dependencies, `Dockerfile`, compose file):
  `docker compose up -d --build proxy-usage`.

## Configuration

| Variable                       | Default                                   | Purpose |
| ------------------------------ | ----------------------------------------- | ------- |
| `CPA_URL`                      | `http://127.0.0.1:8317` (Docker: `http://host.docker.internal:8317`) | CLIProxyAPI base URL |
| `CPA_MANAGEMENT_KEY`           | (none)                                    | Management key for the collector. Without it the UI still works but nothing is collected |
| `CPA_TLS_INSECURE`             | `false`                                   | Accept a self-signed certificate on an https `CPA_URL` |
| `PORT`                         | `18320`                                   | HTTP port (and the host port Docker publishes) |
| `BIND_ADDR`                    | `127.0.0.1`                               | Host interface Docker publishes on; `0.0.0.0` also exposes it on the LAN |
| `ALLOWED_HOSTS`                | (empty)                                   | Extra hostnames to accept besides localhost, IPs, `*.ts.net` and `*.local`; `*` disables the check |
| `DATA_DIR`                     | `./data` (Docker: `/data`)                | Where `usage.sqlite` lives |
| `RETENTION_DAYS`               | `0`                                       | Delete requests older than this; `0` keeps everything |
| `COLLECTOR_MODE`               | `auto`                                    | `auto` (RESP subscribe, HTTP fallback), `resp`, `http` or `off` |
| `COLLECTOR_POLL_MS`            | `1000`                                    | Poll interval of the HTTP fallback |
| `COLLECTOR_BATCH`              | `500`                                     | Records per HTTP poll |
| `AUTO_ENABLE_USAGE_STATISTICS` | `true`                                    | Turn on CLIProxyAPI's `usage-statistics-enabled` if it is off |
| `PRICE_SYNC_INTERVAL_HOURS`    | `24`                                      | Model price refresh interval; `0` disables auto-sync |
| `ANALYTICS_WORKERS`            | `2`                                       | Worker threads that answer analytics queries |
| `LOG_LEVEL`                    | `info`                                    | `debug`, `info`, `warn` or `error` |
| `TS_HOSTNAME`, `TS_AUTHKEY`    | `cpa-usage`, (none)                       | Tailscale sidecar, see below |

## Sign-in and security

- **How sign-in works:** you sign in with the CLIProxyAPI management key. The browser keeps it in
  localStorage when "Remember me" is checked, and in sessionStorage otherwise. The server checks the
  key against CLIProxyAPI and caches the result for a few minutes.
- **Failed attempts:** CLIProxyAPI blocks an IP address for 30 minutes after 5 failed management
  logins, and every call from this server comes from the same address. To keep a few bad sign-ins
  from blocking the collector too, the server caches rejected keys and pauses sign-in after 3
  failures in 30 minutes.
- **What gets stored:** client API keys are stored only as SHA-256 hashes, request sources are
  masked, and only an allowlisted set of response headers is kept. Prompt and response bodies are
  never stored.
- **Host check:** the server only answers to localhost, IP addresses, `*.ts.net`, `*.local` and
  `ALLOWED_HOSTS`.

## Data and backups

History lives in `./data/usage.sqlite` (WAL mode). To back it up, stop the container and copy
`data/`, or run `sqlite3 data/usage.sqlite ".backup backup.sqlite"` while it runs. Deleting `data/`
deletes your history.

## Model prices

Costs are computed per request from the price book. The book syncs automatically from
[models.dev](https://models.dev), falling back to [LiteLLM](https://github.com/BerriAI/litellm) and
[OpenRouter](https://openrouter.ai). Open it from the Usage page to sync on demand, resolve ambiguous
matches or set prices by hand. Manual prices are never overwritten, and changing a price recomputes
the cost of past requests.

## Tailscale

The compose file includes an optional Tailscale sidecar (service `tailscale`). It joins your tailnet
as its own machine and serves the app over HTTPS with Tailscale Serve, inside the tailnet only and
never through Funnel:

```
browser on tailnet ──HTTPS──▶ cpa-usage.<tailnet>.ts.net  (container proxy-usage-tailscale, userspace)
                                   │ Serve proxy, compose network
                                   ▼
                          http://proxy-usage:18320
```

- **Serve config:** `tailscale/serve.json`. The container fills in `${TS_CERT_DOMAIN}`.
- **Node identity:** `tailscale/state/` holds the node identity and TLS certificate (gitignored).
  Deleting it orphans the machine.
- **Auth key:** `TS_AUTHKEY` is only used the first time the node joins. Without a key,
  `docker compose logs tailscale` prints a login URL to approve once instead.
- **Independent of the app:** the sidecar reaches the app by service name, so the app can be
  recreated on its own and `http://127.0.0.1:18320` never depends on Tailscale.
- **Not using Tailscale?** Delete the `tailscale` service from `docker-compose.yml`.

```sh
docker compose ps                              # both services should be healthy
docker compose logs -f tailscale               # NeedsLogin / auth URL = key expired or used up
docker compose exec tailscale tailscale serve status
```

When running the dev server behind `tailscale serve` (HTTPS on 443), set `HMR_CLIENT_PORT=443`.

## Develop

```sh
npm install
npm run dev        # one process on :18320: API + collector + Vite with HMR
npm test           # server and shared unit tests (node:test)
npm run typecheck
npm run build      # production UI build into dist/
npm run publish:ui # build the UI into ./web; the running container serves it without a restart
npm start          # production server: serves dist/, API and collector
```

The server is TypeScript run directly by Node's built-in type stripping. It has no build step and no
runtime npm dependencies (it uses `node:sqlite` and `node:http`).

```
server/
  collector/   usage-queue client (RESP + HTTP), record normalization, auth-file enrichment, writer
  analytics/   analytics queries over SQLite, run in a worker pool
  pricing/     price book, models.dev / LiteLLM / OpenRouter sync, cost recompute
  auth/        management-key verification, /api/status, /api/session, CLIProxyAPI forwarding
  http/ db/    HTTP server, static files, dev middleware, SQLite schema and retention
shared/        types and the cost model used by both the server and the UI
src/
  features/    Usage, Request Monitor, Quota and Quota History pages
  components/  app shell, UI primitives, shared page kit
  lib/         API client, formatting, quota parsers, time ranges
```

## Troubleshooting

- **Sign-in says remote management is disabled:** set `management.allow-remote: true`
  (`remote-management.allow-remote` before v8) or `MANAGEMENT_PASSWORD` in CLIProxyAPI. The Docker container is not a loopback client on every
  platform.
- **Sign-in is paused:** too many wrong keys. Wait for the time shown; CLIProxyAPI itself may block
  the address for 30 minutes.
- **No new requests show up:** check the banner in the app, or `docker compose logs proxy-usage`.
  Typical causes: `CPA_MANAGEMENT_KEY` is missing or wrong, CLIProxyAPI is older than v6.10.8, or
  `usage-statistics-enabled` is off and auto-enable is disabled.
- **Costs show as unpriced:** open the price book on the Usage page and sync, or add the model by
  hand.

## Credits

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) by Luis Pater and contributors, the
  proxy this dashboard is built for.
- [CLI Proxy API Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)
  (MIT): the visual design, theme tokens, app shell and several components are ported from it.
- [CPA Manager Plus](https://github.com/seakee/CPA-Manager-Plus) by Seakee (MIT): this project is
  inspired by it, and the usage collector, analytics semantics, cost model and price sync follow its
  Manager Server.
- Model prices come from [models.dev](https://models.dev),
  [LiteLLM](https://github.com/BerriAI/litellm) and [OpenRouter](https://openrouter.ai).

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licenses.

## License

[MIT](LICENSE)
