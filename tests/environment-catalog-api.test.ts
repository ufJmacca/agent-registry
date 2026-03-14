import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { bootstrapFromConfig } from "../apps/api/src/bootstrap/index.ts";
import { createApiRequestListener } from "../apps/api/src/http.ts";
import { loadRegistryConfig } from "../packages/config/src/index.ts";
import {
  KyselyBootstrapRepository,
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  type AgentRegistryDb,
} from "../packages/db/src/index.ts";
import type {
  CreateTenantEnvironmentResponse,
  ListTenantEnvironmentsResponse,
} from "../packages/contracts/src/index.ts";

const { Pool } = pg;

const integrationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";

interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

interface ApiTestContext extends FreshRegistryDatabase {
  baseUrl: string;
  close(): Promise<void>;
}

interface JsonRequestOptions {
  body?: unknown;
  method?: "GET" | "POST";
  path: string;
  subjectId: string;
  tenantClaim?: string;
}

interface JsonResponse<TBody> {
  body: TBody;
  status: number;
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

async function createEnvironmentApiContext(): Promise<ApiTestContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-environment-api-"));
  const manifestPath = path.join(tempDir, "hosted-bootstrap.yaml");

  try {
    await writeFile(
      manifestPath,
      [
        "tenants:",
        "  - tenantId: tenant-alpha",
        "    displayName: Tenant Alpha",
        "    environments: [dev]",
        "    memberships:",
        "      - subjectId: admin-alpha",
        "        roles: [tenant-admin]",
        "      - subjectId: member-alpha",
        "        roles: [publisher]",
        "  - tenantId: tenant-beta",
        "    displayName: Tenant Beta",
        "    environments: [prod]",
        "    memberships:",
        "      - subjectId: admin-beta",
        "        roles: [tenant-admin]",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = loadRegistryConfig({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "hosted",
      HOSTED_BOOTSTRAP_FILE: manifestPath,
    });

    await bootstrapFromConfig(config, new KyselyBootstrapRepository(database.db));

    const server = http.createServer(
      createApiRequestListener({
        config,
        db: database.db,
      }),
    );

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected an IPv4 test server address");
    }

    return {
      ...database,
      baseUrl: `http://127.0.0.1:${address.port}`,
      async close() {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
        await rm(tempDir, { force: true, recursive: true });
        await database.cleanup();
      },
    };
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true });
    await database.cleanup();
    throw error;
  }
}

async function requestJson<TBody>(
  context: ApiTestContext,
  options: JsonRequestOptions,
): Promise<JsonResponse<TBody>> {
  const headers = new Headers({
    "x-agent-registry-subject-id": options.subjectId,
  });

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  if (options.tenantClaim !== undefined) {
    headers.set("x-agent-registry-tenant-id", options.tenantClaim);
  }

  const response = await fetch(new URL(options.path, context.baseUrl), {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method ?? "GET",
  });
  const bodyText = await response.text();
  const body = bodyText === "" ? null : (JSON.parse(bodyText) as TBody);

  return {
    body: body as TBody,
    status: response.status,
  };
}

async function listStoredEnvironments(db: AgentRegistryDb, tenantId: string): Promise<string[]> {
  const records = await db
    .selectFrom("tenant_environments")
    .select("environment_key")
    .where("tenant_id", "=", tenantId)
    .orderBy("environment_key")
    .execute();

  return records.map((record) => record.environment_key);
}

test("tenant admin can list and create tenant-scoped environments through the API", async () => {
  // Arrange
  const context = await createEnvironmentApiContext();

  try {
    // Act
    const initialList = await requestJson<ListTenantEnvironmentsResponse>(context, {
      path: "/tenants/tenant-alpha/environments",
      subjectId: "admin-alpha",
    });
    const createdEnvironment = await requestJson<CreateTenantEnvironmentResponse>(context, {
      body: { environmentKey: "prod" },
      method: "POST",
      path: "/tenants/tenant-alpha/environments",
      subjectId: "admin-alpha",
    });
    const updatedList = await requestJson<ListTenantEnvironmentsResponse>(context, {
      path: "/tenants/tenant-alpha/environments",
      subjectId: "admin-alpha",
    });
    const storedEnvironments = await listStoredEnvironments(context.db, "tenant-alpha");

    // Assert
    assert.equal(initialList.status, 200);
    assert.deepEqual(initialList.body, {
      environments: [{ environmentKey: "dev" }],
    });
    assert.equal(createdEnvironment.status, 201);
    assert.deepEqual(createdEnvironment.body, {
      environment: { environmentKey: "prod" },
    });
    assert.equal(updatedList.status, 200);
    assert.deepEqual(updatedList.body, {
      environments: [{ environmentKey: "dev" }, { environmentKey: "prod" }],
    });
    assert.deepEqual(storedEnvironments, ["dev", "prod"]);
  } finally {
    await context.close();
  }
});

test("tenant members can list environments but only tenant admins can create them", async () => {
  // Arrange
  const context = await createEnvironmentApiContext();

  try {
    // Act
    const listResponse = await requestJson<ListTenantEnvironmentsResponse>(context, {
      path: "/tenants/tenant-alpha/environments",
      subjectId: "member-alpha",
    });
    const createResponse = await requestJson<{ error: { code: string; message: string } }>(context, {
      body: { environmentKey: "staging" },
      method: "POST",
      path: "/tenants/tenant-alpha/environments",
      subjectId: "member-alpha",
    });
    const storedEnvironments = await listStoredEnvironments(context.db, "tenant-alpha");

    // Assert
    assert.equal(listResponse.status, 200);
    assert.deepEqual(listResponse.body, {
      environments: [{ environmentKey: "dev" }],
    });
    assert.equal(createResponse.status, 403);
    assert.deepEqual(createResponse.body, {
      error: {
        code: "forbidden",
        message: "Tenant admin role is required to create tenant environments.",
      },
    });
    assert.deepEqual(storedEnvironments, ["dev"]);
  } finally {
    await context.close();
  }
});

test("environment creation rejects malformed and duplicate keys without leaking across tenants", async () => {
  // Arrange
  const context = await createEnvironmentApiContext();

  try {
    // Act
    const crossTenantCreate = await requestJson<CreateTenantEnvironmentResponse>(context, {
      body: { environmentKey: "prod" },
      method: "POST",
      path: "/tenants/tenant-alpha/environments",
      subjectId: "admin-alpha",
    });
    const duplicateCreate = await requestJson<{ error: { code: string; message: string } }>(context, {
      body: { environmentKey: "prod" },
      method: "POST",
      path: "/tenants/tenant-alpha/environments",
      subjectId: "admin-alpha",
    });
    const malformedCreate = await requestJson<{ error: { code: string; message: string } }>(context, {
      body: { environmentKey: "Prod East" },
      method: "POST",
      path: "/tenants/tenant-alpha/environments",
      subjectId: "admin-alpha",
    });
    const alphaStoredEnvironments = await listStoredEnvironments(context.db, "tenant-alpha");
    const betaStoredEnvironments = await listStoredEnvironments(context.db, "tenant-beta");

    // Assert
    assert.equal(crossTenantCreate.status, 201);
    assert.deepEqual(crossTenantCreate.body, {
      environment: { environmentKey: "prod" },
    });
    assert.equal(duplicateCreate.status, 409);
    assert.deepEqual(duplicateCreate.body, {
      error: {
        code: "duplicate_environment",
        message: "Environment 'prod' already exists for tenant 'tenant-alpha'.",
      },
    });
    assert.equal(malformedCreate.status, 400);
    assert.deepEqual(malformedCreate.body, {
      error: {
        code: "invalid_environment_key",
        message:
          "Environment keys must be 1-32 characters of lowercase letters, numbers, or hyphens, and must start with a letter.",
      },
    });
    assert.deepEqual(alphaStoredEnvironments, ["dev", "prod"]);
    assert.deepEqual(betaStoredEnvironments, ["prod"]);
  } finally {
    await context.close();
  }
});

test("environment endpoints use bootstrap memberships for the path tenant instead of caller-supplied tenant claims", async () => {
  // Arrange
  const context = await createEnvironmentApiContext();

  try {
    // Act
    const deniedResponse = await requestJson<{ error: { code: string; message: string } }>(context, {
      path: "/tenants/tenant-beta/environments",
      subjectId: "admin-alpha",
      tenantClaim: "tenant-beta",
    });
    const allowedResponse = await requestJson<ListTenantEnvironmentsResponse>(context, {
      path: "/tenants/tenant-alpha/environments",
      subjectId: "admin-alpha",
      tenantClaim: "tenant-beta",
    });

    // Assert
    assert.equal(deniedResponse.status, 403);
    assert.deepEqual(deniedResponse.body, {
      error: {
        code: "forbidden",
        message: "Authenticated subject 'admin-alpha' does not have tenant membership for 'tenant-beta'",
      },
    });
    assert.equal(allowedResponse.status, 200);
    assert.deepEqual(allowedResponse.body, {
      environments: [{ environmentKey: "dev" }],
    });
  } finally {
    await context.close();
  }
});
