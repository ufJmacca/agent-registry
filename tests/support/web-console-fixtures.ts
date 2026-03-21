import assert from "node:assert/strict";
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

const integrationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";

const defaultResolveProbeHostname = async () => ["198.51.100.20"];

interface ConsoleSeed {
  manifest: string;
  subjects: {
    admin: string;
    alternatePublisher?: string;
    publisher: string;
    secondaryAdmin?: string;
  };
  tenants: {
    primary: string;
    secondary?: string;
  };
}

export interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

export interface EmptyRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
}

export interface StartedWebConsoleServer {
  baseUrl: string;
  close(): Promise<void>;
}

export interface ReviewServiceOptions {
  enqueuePublicationProbe?: (publicationId: string) => Promise<void>;
  resolveProbeHostname?: (hostname: string) => Promise<string[]>;
}

export interface WebConsoleContext extends FreshRegistryDatabase {
  baseUrl: string;
  close(): Promise<void>;
  config: RegistryConfig;
  deploymentMode: "hosted" | "self-hosted";
  reviewServiceOptions?: ReviewServiceOptions;
  subjects: ConsoleSeed["subjects"];
  tenants: ConsoleSeed["tenants"];
}

export interface PendingVersionFixture {
  agentId: string;
  environmentKeys: string[];
  publicationIds: Record<string, string>;
  routes: {
    agentDetail: string;
    agentOverlay: {
      deprecate: string;
      disable: string;
    };
    approve: string;
    environmentOverlays: Record<
      string,
      {
        deprecate: string;
        disable: string;
      }
    >;
    reject: string;
    submit: string;
    versionDetail: string;
  };
  tenantId: string;
  versionId: string;
}

function createIsolatedDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function getConsoleSeed(deploymentMode: "hosted" | "self-hosted"): ConsoleSeed {
  if (deploymentMode === "self-hosted") {
    return {
      manifest: [
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
      ].join("\n"),
      subjects: {
        admin: "admin-self-hosted",
        publisher: "publisher-self-hosted",
      },
      tenants: {
        primary: "tenant-self-hosted",
      },
    };
  }

  return {
    manifest: [
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
    ].join("\n"),
    subjects: {
      admin: "admin-alpha",
      alternatePublisher: "publisher-bravo",
      publisher: "publisher-alpha",
      secondaryAdmin: "admin-beta",
    },
    tenants: {
      primary: "tenant-alpha",
      secondary: "tenant-beta",
    },
  };
}

function buildVersionRoutes(
  tenantId: string,
  agentId: string,
  versionId: string,
  environmentKeys: string[],
): PendingVersionFixture["routes"] {
  const agentDetail = `/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}`;
  const versionDetail = `${agentDetail}/versions/${encodeURIComponent(versionId)}`;

  return {
    agentDetail,
    agentOverlay: {
      deprecate: `${agentDetail}/overlay/deprecate`,
      disable: `${agentDetail}/overlay/disable`,
    },
    approve: `${versionDetail}/approve`,
    environmentOverlays: Object.fromEntries(
      environmentKeys.map((environmentKey) => [
        environmentKey,
        {
          deprecate: `${agentDetail}/environments/${encodeURIComponent(environmentKey)}/overlay/deprecate`,
          disable: `${agentDetail}/environments/${encodeURIComponent(environmentKey)}/overlay/disable`,
        },
      ]),
    ),
    reject: `${versionDetail}/reject`,
    submit: `${versionDetail}/submit`,
    versionDetail,
  };
}

export async function createFreshRegistryDatabase(): Promise<FreshRegistryDatabase> {
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

export async function createEmptyRegistryDatabase(): Promise<EmptyRegistryDatabase> {
  const databaseName = `agent_registry_test_${randomUUID().replaceAll("-", "_")}`;
  const adminPool = new Pool({
    connectionString: createIsolatedDatabaseUrl(integrationDatabaseUrl, "postgres"),
  });

  try {
    await adminPool.query(`create database "${databaseName}" template template0`);
  } catch (error) {
    await adminPool.end();
    throw error;
  }

  return {
    async cleanup() {
      await adminPool.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`drop database if exists "${databaseName}"`);
      await adminPool.end();
    },
    databaseUrl: createIsolatedDatabaseUrl(integrationDatabaseUrl, databaseName),
  };
}

export async function startWebConsoleServer(options: {
  config: RegistryConfig;
  db: AgentRegistryDb;
  reviewServiceOptions?: ReviewServiceOptions;
}): Promise<StartedWebConsoleServer> {
  const server = http.createServer(
    createWebRequestListener({
      config: options.config,
      db: options.db,
      reviewServiceOptions: {
        enqueuePublicationProbe: options.reviewServiceOptions?.enqueuePublicationProbe,
        resolveProbeHostname:
          options.reviewServiceOptions?.resolveProbeHostname ?? defaultResolveProbeHostname,
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
    },
  };
}

export async function createWebConsoleContext(options: {
  deploymentMode: "hosted" | "self-hosted";
  reviewServiceOptions?: ReviewServiceOptions;
}): Promise<WebConsoleContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-web-console-"));
  const manifestPath = path.join(tempDir, "bootstrap.yaml");
  const seed = getConsoleSeed(options.deploymentMode);

  try {
    await writeFile(manifestPath, seed.manifest, "utf8");

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

    const server = await startWebConsoleServer({
      config,
      db: database.db,
      reviewServiceOptions: options.reviewServiceOptions,
    });

    return {
      ...database,
      baseUrl: server.baseUrl,
      config,
      deploymentMode: options.deploymentMode,
      reviewServiceOptions: options.reviewServiceOptions,
      subjects: seed.subjects,
      tenants: seed.tenants,
      async close() {
        await server.close();
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

export function getRedirectLocation(response: Response): string {
  const location = response.headers.get("location");

  if (location === null) {
    throw new Error(`Expected redirect location but received status ${response.status}`);
  }

  return location;
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

  assert.equal(response.status, 303);
  assert.equal(getRedirectLocation(response), "/console");
}

async function resolvePrincipal(db: AgentRegistryDb, tenantId: string, subjectId: string) {
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
    agentId?: string;
    displayName: string;
    environments: string[];
    publisherId: string;
    summary: string;
    tenantId?: string;
    versionLabel: string;
  },
): Promise<PendingVersionFixture> {
  const tenantId = input.tenantId ?? context.tenants.primary;
  const principal = await resolvePrincipal(context.db, tenantId, input.publisherId);
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
  const reviewService = new AgentVersionReviewService(new KyselyAgentReviewRepository(context.db), {
    deploymentMode: context.config.deploymentMode,
    requireHttps: context.config.healthProbe.requireHttps,
    resolveProbeHostname:
      context.reviewServiceOptions?.resolveProbeHostname ?? defaultResolveProbeHostname,
  });

  const draft = await draftService.createDraftAgent(
    principal,
    tenantId,
    {
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
    },
    {
      agentId: input.agentId,
    },
  );

  await reviewService.submitVersion(principal, tenantId, draft.agentId, draft.versionId);

  return {
    agentId: draft.agentId,
    environmentKeys: [...input.environments],
    publicationIds: Object.fromEntries(
      draft.publications.map((publication) => [publication.environmentKey, publication.publicationId]),
    ),
    routes: buildVersionRoutes(tenantId, draft.agentId, draft.versionId, input.environments),
    tenantId,
    versionId: draft.versionId,
  };
}

export async function approvePendingVersion(
  context: WebConsoleContext,
  fixture: Pick<PendingVersionFixture, "agentId" | "tenantId" | "versionId">,
): Promise<void> {
  const principal = await resolvePrincipal(context.db, fixture.tenantId, context.subjects.admin);
  const reviewService = new AgentVersionReviewService(new KyselyAgentReviewRepository(context.db), {
    deploymentMode: context.config.deploymentMode,
    requireHttps: context.config.healthProbe.requireHttps,
    resolveProbeHostname:
      context.reviewServiceOptions?.resolveProbeHostname ?? defaultResolveProbeHostname,
  });

  await reviewService.approveVersion(
    principal,
    fixture.tenantId,
    fixture.agentId,
    fixture.versionId,
  );
}

export async function seedHealthAndTelemetry(
  db: AgentRegistryDb,
  fixture: Pick<PendingVersionFixture, "agentId" | "publicationIds" | "tenantId" | "versionId">,
  options: {
    environmentKey?: string;
  } = {},
): Promise<void> {
  const environmentKey = options.environmentKey ?? Object.keys(fixture.publicationIds)[0];

  if (environmentKey === undefined) {
    throw new Error("Expected the fixture to include at least one environment publication.");
  }

  const publicationId = fixture.publicationIds[environmentKey];

  if (publicationId === undefined) {
    throw new Error(`Fixture is missing a publication ID for environment '${environmentKey}'.`);
  }

  const healthRepository = new KyselyHealthRepository(db);
  const telemetryRepository = new KyselyPublicationTelemetryRepository(db);

  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:00:00Z",
    error: null,
    ok: true,
    publicationId,
    statusCode: 200,
  });
  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:01:00Z",
    error: "service unavailable",
    ok: false,
    publicationId,
    statusCode: 503,
  });
  await telemetryRepository.upsertPublicationTelemetry({
    agentId: fixture.agentId,
    environmentKey,
    errorCount: 1,
    invocationCount: 12,
    p50LatencyMs: 120,
    p95LatencyMs: 280,
    successCount: 11,
    tenantId: fixture.tenantId,
    versionId: fixture.versionId,
    windowEndedAt: "2026-03-13T10:15:00Z",
    windowStartedAt: "2026-03-13T10:00:00Z",
  });
}
