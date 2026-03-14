# Agent Registry

Agent Registry is a self-hostable directory and policy service for A2A agent discovery. It stores raw agent cards per environment, approval state, discovery metadata, passthrough header contracts, required execution context, health state, and advisory telemetry. Callers discover approved agents in the registry and invoke the returned agent card directly.

## Bootstrap Flow

The local compose stack is wired for the self-hosted demo tenant by default.

- `DEPLOYMENT_MODE=self-hosted`
- `SELF_HOSTED_BOOTSTRAP_FILE=/workspace/apps/api/src/seed/self-hosted-bootstrap.yaml`
- `DATABASE_URL=postgres://registry:registry@postgres:5432/agent_registry`

Use the public `make` targets for both local work and CI:

- `make up` starts `workspace`, `postgres`, `api`, `worker`, and `web`, and applies migrations before the API and web services boot with the self-hosted bootstrap manifest.
- `make migrate` applies the Kysely migrations in the workspace container.
- `make seed` migrates if needed, bootstraps the self-hosted tenant manifest, and loads demo memberships, environments, sample agents, health history, and telemetry.
- `make lint` runs the TypeScript build as the repository lint gate.
- `make test` runs the workspace foundation flow and the TypeScript test suite in containers.
- `make down` stops the compose stack and removes orphaned services.

For a fresh local run:

```bash
make up
make seed
```

The seed installs one self-hosted tenant, `tenant-demo`, with memberships for `demo-admin`, `demo-publisher`, and `demo-caller`; tenant environments `dev` and `prod`; and approved sample agents including `Case Resolution Copilot` and `Policy Retrieval Assistant`.

## Local Verification

The devcontainer still uses the existing host-mount verification path:

```bash
bash .devcontainer/scripts/post-create.sh --verify-only
```

Compose-based smoke expectations:

```bash
curl -fsS http://127.0.0.1:4000
curl -fsS http://127.0.0.1:3000
```

The API root should respond with the service metadata JSON, and the web root should render the Agent Registry page. After `make seed`, the worker will probe registered health endpoints anonymously. Probes are sent without tenant credentials, user tokens, or redirected follow-ups, so probe behavior stays anonymous relative to caller identity.

## Discovery And Search

Caller-facing discovery is environment-scoped and authorization-filtered.

- `GET /tenants/{tenantId}/agents/available`
- `GET /tenants/{tenantId}/agents/search`

Use `include=rawCard` when a client wants the approved environment-specific raw card inline in the discovery response. Otherwise the response returns metadata plus raw-card availability only.

Example discovery calls after `make seed`:

```bash
curl -fsS \
  -H 'x-agent-registry-subject-id: demo-caller' \
  'http://127.0.0.1:4000/tenants/tenant-demo/agents/available?include=rawCard'

curl -fsS \
  -H 'x-agent-registry-subject-id: demo-caller' \
  'http://127.0.0.1:4000/tenants/tenant-demo/agents/search?q=policy'
```

For direct raw-card retrieval through detail endpoints:

```bash
curl -fsS \
  -H 'x-agent-registry-subject-id: demo-admin' \
  'http://127.0.0.1:4000/tenants/tenant-demo/agents/{agentId}/versions/{versionId}'
```

## Preflight

Preflight evaluates authorization and runtime readiness separately from discovery. It reports whether the caller is authorized, unresolved required header sources, missing required context keys, current health status, and optionally the approved raw card for the selected environment publication.

```bash
curl -fsS \
  -X POST \
  -H 'content-type: application/json' \
  -H 'x-agent-registry-subject-id: demo-caller' \
  'http://127.0.0.1:4000/tenants/tenant-demo/agents/{agentId}/environments/prod:preflight?include=rawCard' \
  -d '{"context":{"client_id":"client-123"}}'
```

## CI

GitHub Actions runs the same public targets used locally:

- `make lint`
- `make test`
- `make migrate`

The workflow lives at `.github/workflows/ci.yml` and finishes with `make down` under `if: always()` so the compose stack is always cleaned up.
