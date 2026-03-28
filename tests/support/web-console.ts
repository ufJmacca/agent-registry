import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import pg from "pg";

import { PrincipalResolver } from "../../packages/auth/src/index.ts";
import { loadRegistryConfig, type RegistryConfig } from "../../packages/config/src/index.ts";
import {
  KyselyAgentDraftRegistrationRepository,
  KyselyAgentReviewRepository,
  KyselyBootstrapRepository,
  KyselyHealthRepository,
  KyselyPublicationTelemetryRepository,
  KyselyTenantEnvironmentRepository,
  KyselyTenantMembershipLookup,
  KyselyTenantRepository,
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  type AgentRegistryDb,
} from "../../packages/db/src/index.ts";
import { bootstrapFromConfig } from "../../apps/api/src/bootstrap/index.ts";
import { AgentDraftRegistrationService } from "../../apps/api/src/modules/agents/service.ts";
import { AgentVersionReviewService } from "../../apps/api/src/modules/review/service.ts";
import { createWebRequestListener } from "../../apps/web/src/http.ts";

const { Pool } = pg;

function getIntegrationDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";
}

export interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

export interface WebConsoleContext extends FreshRegistryDatabase {
  baseUrl: string;
  close(): Promise<void>;
  config: RegistryConfig;
}

export interface PendingVersionFixture {
  agentId: string;
  versionId: string;
}

export interface VisualRegressionFixture extends WebConsoleContext {
  approvedFixture: PendingVersionFixture;
  pendingFixture: PendingVersionFixture;
  routes: {
    activeAgentDetail: string;
    consoleDashboard: string;
    environmentManagement: string;
    newDraftRegistration: string;
    reviewQueue: string;
    signInLanding: string;
    versionDetail: string;
  };
  tenantId: string;
}

function createIsolatedDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createFreshRegistryDatabase(): Promise<FreshRegistryDatabase> {
  const databaseName = `agent_registry_test_${randomUUID().replaceAll("-", "_")}`;
  const integrationDatabaseUrl = getIntegrationDatabaseUrl();
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

export async function createWebConsoleContext(options: {
  deploymentMode: "hosted" | "self-hosted";
  reviewServiceOptions?: {
    enqueuePublicationProbe?: (publicationId: string) => Promise<void>;
    resolveProbeHostname?: (hostname: string) => Promise<string[]>;
  };
}): Promise<WebConsoleContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-web-console-"));
  const manifestPath = path.join(tempDir, "bootstrap.yaml");

  try {
    const manifest =
      options.deploymentMode === "self-hosted"
        ? [
            "tenants:",
            "  - tenantId: tenant-self-hosted",
            "    displayName: Tenant Self Hosted",
            "    environments: [dev, prod]",
            "    memberships:",
            "      - subjectId: admin-self-hosted",
            "        roles: [tenant-admin]",
            "      - subjectId: publisher-self-hosted",
            "        roles: [publisher]",
            "",
          ].join("\n")
        : [
            "tenants:",
            "  - tenantId: tenant-alpha",
            "    displayName: Tenant Alpha",
            "    environments: [dev, prod, staging]",
            "    memberships:",
            "      - subjectId: admin-alpha",
            "        roles: [tenant-admin]",
            "      - subjectId: publisher-alpha",
            "        roles: [publisher]",
            "      - subjectId: publisher-bravo",
            "        roles: [publisher]",
            "  - tenantId: tenant-beta",
            "    displayName: Tenant Beta",
            "    environments: [test]",
            "    memberships:",
            "      - subjectId: admin-beta",
            "        roles: [tenant-admin]",
            "",
          ].join("\n");

    await writeFile(manifestPath, manifest, "utf8");

    const config = loadRegistryConfig(
      options.deploymentMode === "self-hosted"
        ? {
            DATABASE_URL: database.databaseUrl,
            DEPLOYMENT_MODE: "self-hosted",
            SELF_HOSTED_BOOTSTRAP_FILE: manifestPath,
          }
        : {
            DATABASE_URL: database.databaseUrl,
            DEPLOYMENT_MODE: "hosted",
            HOSTED_BOOTSTRAP_FILE: manifestPath,
          },
    );

    await bootstrapFromConfig(config, new KyselyBootstrapRepository(database.db));

    const server = http.createServer(
      createWebRequestListener({
        config,
        db: database.db,
        reviewServiceOptions: {
          resolveProbeHostname:
            options.reviewServiceOptions?.resolveProbeHostname ?? (async () => ["198.51.100.20"]),
          enqueuePublicationProbe: options.reviewServiceOptions?.enqueuePublicationProbe,
        },
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
      config,
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

export function createRawCard(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      capabilities: ["card-search"],
      invocationEndpoint: "https://agent.example.com/invoke",
      name: "Case Resolver",
      summary: "Handles support case routing.",
      tags: ["card-tag"],
      ...overrides,
    },
    null,
    2,
  );
}

export class BrowserSession {
  private readonly baseUrl: string;

  private readonly cookies = new Map<string, string>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async get(pathname: string): Promise<Response> {
    return this.request(pathname, {
      method: "GET",
    });
  }

  async postForm(pathname: string, formData: FormData): Promise<Response> {
    return this.request(pathname, {
      body: formData,
      method: "POST",
    });
  }

  async postUrlEncoded(pathname: string, values: Record<string, string>): Promise<Response> {
    return this.request(pathname, {
      body: new URLSearchParams(values),
      method: "POST",
    });
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookieHeader = [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    if (cookieHeader !== "") {
      headers.set("cookie", cookieHeader);
    }

    const response = await fetch(new URL(pathname, this.baseUrl), {
      ...init,
      headers,
      redirect: "manual",
    });
    const setCookieHeader =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];

    for (const cookie of setCookieHeader) {
      const [pair] = cookie.split(";", 1);
      const separatorIndex = pair.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const name = pair.slice(0, separatorIndex);
      const value = pair.slice(separatorIndex + 1);

      if (value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }

    return response;
  }
}

export async function signIn(
  browser: BrowserSession,
  tenantId: string,
  subjectId: string,
): Promise<void> {
  const response = await browser.postUrlEncoded("/session", {
    subjectId,
    tenantId,
  });

  if (response.status !== 303 || response.headers.get("location") !== "/console") {
    throw new Error(`Expected sign-in redirect to /console but received ${response.status}`);
  }
}

async function resolvePrincipal(
  db: AgentRegistryDb,
  tenantId: string,
  subjectId: string,
) {
  return new PrincipalResolver(new KyselyTenantMembershipLookup(db)).resolve({
    auth: {
      subjectId,
    },
    tenantId,
  });
}

export async function createPendingVersion(
  context: WebConsoleContext,
  input: {
    displayName: string;
    environments: string[];
    publisherId: string;
    summary: string;
    versionLabel: string;
  },
): Promise<PendingVersionFixture> {
  const principal = await resolvePrincipal(context.db, "tenant-alpha", input.publisherId);
  const draftService = new AgentDraftRegistrationService(
    new KyselyAgentDraftRegistrationRepository(context.db),
    new KyselyTenantEnvironmentRepository(context.db),
    new KyselyTenantRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      rawCardByteLimit: context.config.rawCardByteLimit,
      requireHttpsHealthEndpoints: context.config.healthProbe.requireHttps,
    },
  );
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      requireHttps: context.config.healthProbe.requireHttps,
      resolveProbeHostname: async () => ["198.51.100.20"],
    },
  );

  const draft = await draftService.createDraftAgent(principal, "tenant-alpha", {
    capabilities: ["shared-capability"],
    contextContract: [
      {
        description: "Selects the client partition.",
        example: "client-123",
        key: "client_id",
        required: true,
        type: "string",
      },
    ],
    displayName: input.displayName,
    headerContract: [
      {
        description: "Passes the calling user identifier.",
        name: "X-User-Id",
        required: true,
        source: "user.id",
      },
    ],
    publications: input.environments.map((environmentKey) => ({
      environmentKey,
      healthEndpointUrl: `https://${environmentKey}.health.example.com/status`,
      rawCard: createRawCard({
        capabilities: ["card-search", `${environmentKey}-capability`],
        name: input.displayName,
        summary: input.summary,
        tags: ["card-tag", environmentKey],
      }),
    })),
    requiredRoles: ["support-agent"],
    requiredScopes: ["tickets.read"],
    summary: input.summary,
    tags: ["shared-tag"],
    versionLabel: input.versionLabel,
  });

  await reviewService.submitVersion(principal, "tenant-alpha", draft.agentId, draft.versionId);

  return {
    agentId: draft.agentId,
    versionId: draft.versionId,
  };
}

export async function approvePendingVersion(
  context: WebConsoleContext,
  fixture: PendingVersionFixture,
): Promise<void> {
  const principal = await resolvePrincipal(context.db, "tenant-alpha", "admin-alpha");
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      requireHttps: context.config.healthProbe.requireHttps,
      resolveProbeHostname: async () => ["198.51.100.20"],
    },
  );

  await reviewService.approveVersion(principal, "tenant-alpha", fixture.agentId, fixture.versionId);
}

export async function seedHealthAndTelemetry(
  db: AgentRegistryDb,
  fixture: PendingVersionFixture,
): Promise<void> {
  const publication = await db
    .selectFrom("environment_publications")
    .select(["publication_id", "environment_key"])
    .where("tenant_id", "=", "tenant-alpha")
    .where("agent_id", "=", fixture.agentId)
    .where("version_id", "=", fixture.versionId)
    .where("environment_key", "=", "dev")
    .executeTakeFirstOrThrow();

  const healthRepository = new KyselyHealthRepository(db);
  const telemetryRepository = new KyselyPublicationTelemetryRepository(db);

  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:00:00Z",
    error: null,
    ok: true,
    publicationId: publication.publication_id,
    statusCode: 200,
  });
  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:01:00Z",
    error: "service unavailable",
    ok: false,
    publicationId: publication.publication_id,
    statusCode: 503,
  });
  await telemetryRepository.upsertPublicationTelemetry({
    agentId: fixture.agentId,
    environmentKey: publication.environment_key,
    errorCount: 1,
    invocationCount: 12,
    p50LatencyMs: 120,
    p95LatencyMs: 280,
    successCount: 11,
    tenantId: "tenant-alpha",
    versionId: fixture.versionId,
    windowEndedAt: "2026-03-13T10:15:00Z",
    windowStartedAt: "2026-03-13T10:00:00Z",
  });
}

export async function createVisualRegressionFixture(): Promise<VisualRegressionFixture> {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });

  try {
    const approvedFixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev", "prod"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });

    await approvePendingVersion(context, approvedFixture);
    await seedHealthAndTelemetry(context.db, approvedFixture);

    const pendingFixture = await createPendingVersion(context, {
      displayName: "Case Escalator",
      environments: ["dev"],
      publisherId: "publisher-alpha",
      summary: "Escalates complex cases.",
      versionLabel: "v2",
    });

    const tenantId = "tenant-alpha";

    return {
      ...context,
      approvedFixture,
      pendingFixture,
      routes: {
        activeAgentDetail: `/tenants/${tenantId}/agents/${approvedFixture.agentId}`,
        consoleDashboard: "/console",
        environmentManagement: `/tenants/${tenantId}/environments`,
        newDraftRegistration: `/tenants/${tenantId}/drafts/new`,
        reviewQueue: `/tenants/${tenantId}/review`,
        signInLanding: "/",
        versionDetail: `/tenants/${tenantId}/agents/${approvedFixture.agentId}/versions/${approvedFixture.versionId}`,
      },
      tenantId,
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
