# CPA Usage

## After every change

The running container collects every CLIProxyAPI request. Restarting it can drop requests, so never
restart, rebuild, stop or recreate it: no `docker compose up/restart/stop/down/build/kill/rm` and no
`docker restart/stop/kill/rm` on `proxy-usage`. Only the user does that.

- **UI change** (`src/`, `public/`, `index.html`, or `shared/` code the UI uses): publish it live with

  ```bash
  npm run publish:ui
  ```

  It typechecks, builds and swaps the UI in `./web`, which the container serves without a restart.
- **Backend change** (`server/`, `shared/` code the server imports, `package.json` dependencies,
  `Dockerfile`, `docker-compose.yml`): run the tests, publish the UI if it changed too, then tell the
  user the backend needs a manual rebuild (`docker compose up -d --build proxy-usage`). Do not run it.

To try backend changes, run a separate instance on another port with a temporary `DATA_DIR` and
`COLLECTOR_MODE=off` (or a fake CLIProxyAPI), never the real container.

## Data

`./data` holds the usage history (`usage.sqlite`). Never delete or overwrite it. Use a temporary
`DATA_DIR` for experiments. Never open `./data/usage.sqlite` with `sqlite3` or any other tool from
the host while the container runs: SQLite locking does not work across the Docker VM boundary and
this has corrupted the database before. Copy data out through the app's API or from inside the
container.

## CLIProxyAPI safety

CLIProxyAPI blocks an IP address for 30 minutes after 5 failed management-key attempts, and that
would also cut off the collector. Never send a wrong or empty management key to the real
CLIProxyAPI while testing; use a fake server for failure paths.
