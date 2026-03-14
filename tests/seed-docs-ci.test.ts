import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import pg from "pg";
import YAML from "yaml";

import {
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  type AgentRegistryDb,
} from "../packages/db/src/index.ts";

const execFileAsync = promisify(execFile);
const { Pool } = pg;

const integrationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const expectedCaseResolutionProdRawCard = JSON.stringify(
  {
    capabilities: ["case-resolution", "timeline"],
    invocationEndpoint: "https://case-resolution.prod.example.com/invoke",
    name: "Case Resolution Copilot",
    summary: "Guides a support user through case triage and next-step drafting.",
    tags: ["cases", "support"],
  },
  null,
  2,
);

interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

function createIsolatedDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createFreshRegistryDatabase(): Promise<FreshRegistryDatabase> {
  const databaseName = `agent_registry_test_${randomUUID().replaceAll("-", "_")}`;
  const adminPool = new Pool({
    connectionString: createIsolatedDatabaseUrl(integrationDatabaseUrl, "postgres"),
  });

  await adminPool.query(`create database "${databaseName}" template template0`);

  const databaseUrl = createIsolatedDatabaseUrl(integrationDatabaseUrl, databaseName);
  const db = createKyselyDb(databaseUrl);

  try {
    await migrateToLatest(db);

    return {
      async cleanup() {
        await destroyKyselyDb(db);
        await adminPool.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [databaseName],
        );
        await adminPool.query(`drop database if exists "${databaseName}"`);
        await adminPool.end();
      },
      databaseUrl,
      db,
    };
  } catch (error) {
    await destroyKyselyDb(db);
    await adminPool.query(`drop database if exists "${databaseName}"`);
    await adminPool.end();
    throw error;
  }
}

async function createSelfHostedBootstrapManifest(): Promise<{
  cleanup(): Promise<void>;
  manifestPath: string;
}> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-seed-bootstrap-"));
  const manifestPath = path.join(tempDir, "self-hosted-bootstrap.yaml");

  await writeFile(
    manifestPath,
    [
      "tenants:",
      "  - tenantId: tenant-demo",
      "    displayName: Demo Tenant",
      "    environments: [dev, prod]",
      "    memberships:",
      "      - subjectId: demo-admin",
      "        roles: [tenant-admin]",
      "        userContext:",
      "          id: demo-admin",
      "          email: demo-admin@example.com",
      "      - subjectId: demo-publisher",
      "        roles: [publisher]",
      "        userContext:",
      "          id: demo-publisher",
      "          email: demo-publisher@example.com",
      "      - subjectId: demo-caller",
      "        roles: [support-agent]",
      "        scopes: [cases.read, cases.write]",
      "        userContext:",
      "          id: demo-caller",
      "          email: demo-caller@example.com",
      "          department: support",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    async cleanup() {
      await rm(tempDir, { force: true, recursive: true });
    },
    manifestPath,
  };
}

async function runSeedScript(env: NodeJS.ProcessEnv): Promise<{
  stderr: string;
  stdout: string;
}> {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/seed.ts"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...env,
      },
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

function extractRunCommands(runStep: string): string[] {
  return runStep
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function workflowRunsExactCommand(
  steps: Array<{
    if?: string;
    run?: string;
  }>,
  command: string,
  expectedIf?: string,
): boolean {
  return steps.some((step) => {
    if (expectedIf !== undefined && step.if !== expectedIf) {
      return false;
    }

    if (step.run === undefined) {
      return false;
    }

    return extractRunCommands(step.run).includes(command);
  });
}

function extractMakeTargetCommands(makefileSource: string, targetName: string): string[] {
  const lines = makefileSource.split("\n");
  const commands: string[] = [];
  let inTarget = false;

  for (const line of lines) {
    if (!inTarget) {
      if (line.startsWith(`${targetName}:`)) {
        inTarget = true;
      }

      continue;
    }

    if (/^[A-Za-z0-9_.-]+:/.test(line) && !line.startsWith("\t")) {
      break;
    }

    if (line.startsWith("\t")) {
      commands.push(line.trim().replace(/^@/, ""));
    }
  }

  return commands;
}

test("seed script bootstraps a demo self-hosted tenant with sample agents, health history, and telemetry", async () => {
  // Arrange: provision a fresh registry database and bootstrap manifest for the seed run.
  const database = await createFreshRegistryDatabase();
  const bootstrapManifest = await createSelfHostedBootstrapManifest();

  try {
    // Act: run the public seed script against the isolated database.
    const result = await runSeedScript({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "self-hosted",
      SELF_HOSTED_BOOTSTRAP_FILE: bootstrapManifest.manifestPath,
    });

    // Assert: the seed path created the expected self-hosted demo records and reported them.
    assert.match(result.stdout, /Seeded demo tenant 'tenant-demo'/);

    const tenant = await database.db
      .selectFrom("tenants")
      .select(["deployment_mode", "display_name", "tenant_id"])
      .executeTakeFirstOrThrow();

    assert.deepEqual(tenant, {
      deployment_mode: "self-hosted",
      display_name: "Demo Tenant",
      tenant_id: "tenant-demo",
    });

    const environments = await database.db
      .selectFrom("tenant_environments")
      .select("environment_key")
      .where("tenant_id", "=", "tenant-demo")
      .orderBy("environment_key")
      .execute();

    assert.deepEqual(
      environments.map((environment) => environment.environment_key),
      ["dev", "prod"],
    );

    const memberships = await database.db
      .selectFrom("tenant_memberships")
      .select("subject_id")
      .where("tenant_id", "=", "tenant-demo")
      .orderBy("subject_id")
      .execute();

    assert.deepEqual(
      memberships.map((membership) => membership.subject_id),
      ["demo-admin", "demo-caller", "demo-publisher"],
    );

    const agents = await database.db
      .selectFrom("agents")
      .select(["active_version_id", "display_name"])
      .where("tenant_id", "=", "tenant-demo")
      .orderBy("display_name")
      .execute();

    assert.deepEqual(
      agents.map((agent) => agent.display_name),
      ["Case Resolution Copilot", "Policy Retrieval Assistant"],
    );
    assert.ok(agents.every((agent) => agent.active_version_id !== null));

    const publications = await database.db
      .selectFrom("environment_publications")
      .innerJoin("agent_versions", (join) =>
        join
          .onRef("agent_versions.tenant_id", "=", "environment_publications.tenant_id")
          .onRef("agent_versions.agent_id", "=", "environment_publications.agent_id")
          .onRef("agent_versions.version_id", "=", "environment_publications.version_id"),
      )
      .select([
        "agent_versions.display_name as display_name",
        "environment_publications.environment_key",
        "environment_publications.raw_card",
      ])
      .where("environment_publications.tenant_id", "=", "tenant-demo")
      .where("agent_versions.approval_state", "=", "approved")
      .orderBy("agent_versions.display_name")
      .orderBy("environment_publications.environment_key")
      .execute();

    assert.equal(publications.length, 3);
    assert.equal(
      publications.find(
        (publication) =>
          publication.display_name === "Case Resolution Copilot" &&
          publication.environment_key === "prod",
      )?.raw_card,
      expectedCaseResolutionProdRawCard,
    );

    const healthStatuses = await database.db
      .selectFrom("publication_health")
      .innerJoin(
        "environment_publications",
        "environment_publications.publication_id",
        "publication_health.publication_id",
      )
      .innerJoin("agent_versions", (join) =>
        join
          .onRef("agent_versions.tenant_id", "=", "environment_publications.tenant_id")
          .onRef("agent_versions.agent_id", "=", "environment_publications.agent_id")
          .onRef("agent_versions.version_id", "=", "environment_publications.version_id"),
      )
      .select([
        "agent_versions.display_name as display_name",
        "environment_publications.environment_key",
        "publication_health.health_status",
      ])
      .where("environment_publications.tenant_id", "=", "tenant-demo")
      .orderBy("agent_versions.display_name")
      .orderBy("environment_publications.environment_key")
      .execute();

    assert.deepEqual(
      healthStatuses.map((status) => ({
        displayName: status.display_name,
        environmentKey: status.environment_key,
        healthStatus: status.health_status,
      })),
      [
        {
          displayName: "Case Resolution Copilot",
          environmentKey: "dev",
          healthStatus: "healthy",
        },
        {
          displayName: "Case Resolution Copilot",
          environmentKey: "prod",
          healthStatus: "degraded",
        },
        {
          displayName: "Policy Retrieval Assistant",
          environmentKey: "prod",
          healthStatus: "unreachable",
        },
      ],
    );

    const probeCount = await database.db
      .selectFrom("publication_probe_history")
      .select((expressionBuilder) =>
        expressionBuilder.fn.count<number>("publication_probe_history.probe_id").as("count"),
      )
      .executeTakeFirstOrThrow();

    assert.equal(Number(probeCount.count), 7);

    const telemetry = await database.db
      .selectFrom("publication_telemetry")
      .innerJoin(
        "environment_publications",
        "environment_publications.publication_id",
        "publication_telemetry.publication_id",
      )
      .innerJoin("agent_versions", (join) =>
        join
          .onRef("agent_versions.tenant_id", "=", "environment_publications.tenant_id")
          .onRef("agent_versions.agent_id", "=", "environment_publications.agent_id")
          .onRef("agent_versions.version_id", "=", "environment_publications.version_id"),
      )
      .select([
        "agent_versions.display_name as display_name",
        "environment_publications.environment_key",
        "publication_telemetry.invocation_count",
        "publication_telemetry.success_count",
      ])
      .where("publication_telemetry.tenant_id", "=", "tenant-demo")
      .orderBy("agent_versions.display_name")
      .execute();

    assert.deepEqual(
      telemetry.map((entry) => ({
        displayName: entry.display_name,
        environmentKey: entry.environment_key,
        invocationCount: entry.invocation_count,
        successCount: entry.success_count,
      })),
      [
        {
          displayName: "Case Resolution Copilot",
          environmentKey: "prod",
          invocationCount: 24,
          successCount: 22,
        },
        {
          displayName: "Policy Retrieval Assistant",
          environmentKey: "prod",
          invocationCount: 11,
          successCount: 10,
        },
      ],
    );
  } finally {
    await bootstrapManifest.cleanup();
    await database.cleanup();
  }
});

test("make test runs the non-recursive public workflow proof before the inner workspace suite", async () => {
  // Arrange: load the public Makefile that both local development and CI invoke.
  const makefileSource = await readFile(path.join(repositoryRoot, "Makefile"), "utf8");

  // Act: extract the shell commands that define the public test target.
  const commands = extractMakeTargetCommands(makefileSource, "test");
  const outerProofCommand = "bash tests/workspace-foundation.test.sh --mode=outer --suite=automation";
  const innerSuiteCommand =
    '$(COMPOSE) exec -T workspace bash -lc "./scripts/bootstrap.sh && npm run test:inner"';

  // Assert: `make test` must exercise the host-side public workflow proof before entering the inner suite.
  assert.ok(commands.includes("$(call require_docker,make test)"));
  assert.ok(commands.includes(outerProofCommand));
  assert.ok(commands.includes(innerSuiteCommand));
  assert.ok(commands.indexOf(outerProofCommand) < commands.indexOf(innerSuiteCommand));
});

test("README documents bootstrap, local workflows, discovery, raw-card retrieval, preflight, and verification guidance", async () => {
  // Arrange: load the repository README as the published operator-facing guide.
  const readme = await readFile(path.join(repositoryRoot, "README.md"), "utf8");

  // Act: collect the commands and product capabilities that the slice must document.
  const requiredSnippets = [
    "make up",
    "make migrate",
    "make seed",
    "make lint",
    "make test",
    "make down",
    "DATABASE_URL",
    "DEPLOYMENT_MODE=self-hosted",
    "SELF_HOSTED_BOOTSTRAP_FILE",
    "GET /tenants/{tenantId}/agents/available",
    "GET /tenants/{tenantId}/agents/search",
    "include=rawCard",
    ":preflight",
    ".devcontainer/scripts/post-create.sh --verify-only",
    "curl -fsS http://127.0.0.1:4000",
    "curl -fsS http://127.0.0.1:3000",
    "anonymous",
  ];

  // Assert: the README covers the required bootstrap and verification flow without omission.
  for (const snippet of requiredSnippets) {
    assert.match(readme, new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("GitHub Actions runs the same make lint, make test, and make migrate commands used locally", async () => {
  // Arrange: load the repository workflow definition from the committed GitHub Actions path.
  const workflowSource = await readFile(
    path.join(repositoryRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );

  // Act: parse the workflow and collect shell commands from its steps.
  const workflow = YAML.parse(workflowSource) as {
    jobs?: {
      ci?: {
        steps?: Array<{
          if?: string;
          run?: string;
        }>;
      };
    };
  };
  const runSteps = workflow.jobs?.ci?.steps?.flatMap((step) => (step.run ? [step] : [])) ?? [];

  // Assert: CI invokes the same public make targets and tears the compose stack down afterward.
  assert.ok(workflowRunsExactCommand(runSteps, "make lint"));
  assert.ok(workflowRunsExactCommand(runSteps, "make test"));
  assert.ok(workflowRunsExactCommand(runSteps, "make migrate"));
  assert.ok(workflowRunsExactCommand(runSteps, "make down", "always()"));
});
