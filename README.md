# ScalarRE Config Tool

A GUI + headless tool for authoring the configuration of **ScalarRE** (an
exactly-once DB-to-DB message transfer engine built on ScalarDB). It lets you:

- Build and validate `scalar-re-config.yml` in a React UI
- Generate Docker Compose files and Kubernetes manifests from the config
- Verify database connectivity (non-destructive) against the config
- Initialize the ScalarRE schemas (management tables, outbox/inbox/hold tables)

Databases and networking are **your environment's responsibility**: the tool
connects to whatever databases the config points at, so they must be reachable
from wherever the tool runs.

## Quick start (container)

No configuration is required to start the UI:

```bash
docker run -d --name scalar-re-config \
  -p 127.0.0.1:8088:8088 \
  ghcr.io/yu2scalar/scalar-re-config:0.9.0
```

Open <https://localhost:8088/> — the server uses a self-signed certificate by
default, so accept the browser warning. From the UI you can author a config
from scratch, or click **Open** and load
[`samples/scalar-re-config.yml`](samples/scalar-re-config.yml) as a starting
point.

By default there is no authentication and the destructive **Recreate** action
is disabled; see [TLS and authentication](#tls-and-authentication) to enable it.

## Modes

The same image (and jar) runs in two modes, selected by the `--mode` argument:

| Mode | What it does |
|---|---|
| `serve` (default) | Web server hosting the React UI and the `/api/**` endpoints |
| `init` | Headless one-shot: load + validate the config, verify DB connectivity, create the ScalarRE schemas, then exit |

`init` usage — mount your config and pass DB credentials as environment
variables (see [Config placeholders](#config-placeholders)):

```bash
docker run --rm \
  -v "$(pwd)/scalar-re-config.yml:/conf/scalar-re-config.yml:ro" \
  ghcr.io/yu2scalar/scalar-re-config:0.9.0 \
  --mode=init --config=/conf/scalar-re-config.yml
```

`init` flags and exit codes:

| Flag | Effect |
|---|---|
| `--verify-only` | Stop after load + validate + DB connectivity check (no schema creation) |
| `--recreate-schema` | **Destructive**: drop and re-create all ScalarRE tables (DATA LOSS) |

Exit code `0` = success, `1` = load/validation/verify/init failure, `2` = usage
error (missing `--config`, unknown mode).

## Configuration (environment variables)

**Required: none.** Everything below is optional.

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `8088` | HTTP(S) listen port |
| `SERVER_ADDRESS` | `0.0.0.0` (container) | Bind address. On a loopback bind, serve mode auto-opens a browser |
| `ADMIN_PASSWORD` | (unset) | Enables HTTP Basic auth (user `admin`) and unlocks the destructive **Recreate** action |
| `TLS_ENABLED` | `true` | Set `false` for plain HTTP (e.g. behind your own TLS termination) |
| `TLS_KEYSTORE_PATH` / `TLS_KEYSTORE_PASSWORD` | (unset) | Bring your own keystore instead of the auto-generated self-signed cert. Optional: `TLS_KEYSTORE_TYPE`, `TLS_KEYSTORE_ALIAS` |
| `CONFIG_TOOL_OPEN_BROWSER` | `true` | Set `false` to suppress the browser auto-launch on loopback binds |
| `CONFIG_TOOL_DB_VERIFY_TIMEOUT_MS` | `10000` | Overall timeout for a DB connectivity check |
| `CONFIG_TOOL_DB_INIT_TIMEOUT_MS` | `120000` | Overall timeout for schema initialization |
| `SCALAR_RE_*` | per config | Values for `${VAR:default}` placeholders in your config (DB hosts, credentials, API keys, HMAC keys) |

## TLS and authentication

- **Default**: HTTPS with a self-signed certificate (regenerated on each start,
  CN=`ScalarRE Config Tool`, SAN=`localhost,127.0.0.1`), no authentication.
- **Fixed certificate**: mount a keystore and set `TLS_KEYSTORE_PATH` +
  `TLS_KEYSTORE_PASSWORD`.
- **Login**: set `ADMIN_PASSWORD` to require HTTP Basic (user `admin`) on the
  UI and `/api/**` (`GET /`, static assets, and `/api/meta` stay open).
- **Destructive-operation gate**: `Recreate` (drop + re-create tables) is only
  allowed when `ADMIN_PASSWORD` is set. Without it the backend returns
  403 and the UI disables the Recreate buttons. The headless
  `--mode=init --recreate-schema` CLI is exempt (operator-local).

## DB operations from the UI

The serve UI wires deploy/admin operations against the real databases in your
config (this layer is separate from the ScalarRE runtime itself):

- **Storage screen** — *Connection Params* (e.g. `sslMode=REQUIRED`, appended
  to the JDBC URL) and *Test Connection* (non-destructive).
- **Namespace screen** — *Check Status* (namespace + expected ScalarRE tables),
  *Create* (idempotent), *Recreate* (destructive, type-to-confirm, gated on
  admin auth).

## Config placeholders

Config values may use `${VAR:default}` placeholders (see the sample config).
On the verify/init path each placeholder resolves to the environment variable
`VAR` if set, otherwise to the default. This keeps credentials out of the
config file: pass them as container environment variables instead.

## Optional: local test databases

For evaluating the tool without your own databases, you can run disposable
test DBs alongside it (dev use only — data is not persisted meaningfully):

```bash
docker network create scalar-re-config-net

docker run -d --name srcfg-mysql --network scalar-re-config-net --network-alias mysql \
  -e MYSQL_ROOT_PASSWORD=rootpassword \
  -v "$(pwd)/deploy/db-init/mysql:/docker-entrypoint-initdb.d:ro" \
  mysql:8.0

docker run -d --name srcfg-postgres --network scalar-re-config-net --network-alias postgres \
  -e POSTGRES_PASSWORD=rootpassword \
  -v "$(pwd)/deploy/db-init/postgres:/docker-entrypoint-initdb.d:ro" \
  postgres:15

docker run -d --name srcfg-dynamodb --network scalar-re-config-net --network-alias dynamodb \
  amazon/dynamodb-local:latest -jar DynamoDBLocal.jar -sharedDb -inMemory
```

Then start the tool on the same network, pointing the sample config's
placeholders at those containers:

```bash
docker run -d --name scalar-re-config --network scalar-re-config-net \
  -p 127.0.0.1:8088:8088 \
  -e SCALAR_RE_DB_MYSQL_HOST=mysql \
  -e SCALAR_RE_DB_POSTGRES_HOST=postgres \
  -e SCALAR_RE_DB_DYNAMO_ENDPOINT=http://dynamodb:8000 \
  ghcr.io/yu2scalar/scalar-re-config:0.9.0
```

Load `samples/scalar-re-config.yml` in the UI; Test Connection / Check Status /
Create now work against the test DBs. The `deploy/db-init/` scripts create the
`scalaradmin` accounts the sample config expects.

## Kubernetes init Job

[`deploy/k8s/configtool-init-job.yaml`](deploy/k8s/configtool-init-job.yaml) is
a sample one-shot Job that runs `--mode=init` in-cluster, reaching databases by
service DNS:

```bash
kubectl apply -f deploy/k8s/configtool-init-job.yaml
kubectl -n scalar-re wait --for=condition=complete job/configtool-init --timeout=240s
kubectl -n scalar-re logs job/configtool-init
```

## Build from source

Prerequisites: Java 17, Node.js 20 (npm).

```bash
./gradlew bootJar        # builds the frontend (npm ci + vite build) and bundles it
java -jar build/libs/scalar-re-config-0.9.0.jar            # serve mode
docker build -t scalar-re-config:dev .                      # container image
```

Regression check (compares generator output against frozen golden files):

```bash
TLS_ENABLED=false java -jar build/libs/scalar-re-config-0.9.0.jar &
./verify/golden-check.sh
```

## License

[Apache License 2.0](LICENSE)
