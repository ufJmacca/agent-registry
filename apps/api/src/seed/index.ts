import { fileURLToPath } from "node:url";

import { loadRegistryConfig } from "@agent-registry/config";
import type { CreateDraftAgentRequest, UpsertPublicationTelemetryRequest } from "@agent-registry/contracts";
import {
  KyselyAgentDraftRegistrationRepository,
  KyselyAgentReviewRepository,
  KyselyBootstrapRepository,
  KyselyHealthRepository,
  KyselyPublicationTelemetryRepository,
  KyselyTenantEnvironmentRepository,
  KyselyTenantRepository,
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  normalizeLegacyTelemetryMigrationRows,
  type AgentRegistryDb,
} from "@agent-registry/db";

import { createPrincipalResolver } from "../auth/index.js";
import {
  bootstrapFromConfig,
  loadBootstrapManifest,
  type BootstrapTenantManifest,
} from "../bootstrap/index.js";
import { AgentDraftRegistrationService } from "../modules/agents/service.js";
import { AgentVersionReviewService } from "../modules/review/service.js";
import { PublicationTelemetryService } from "../modules/telemetry/service.js";

const defaultSelfHostedBootstrapFile = fileURLToPath(
  new URL("./self-hosted-bootstrap.yaml", import.meta.url),
);

interface DemoProbeCheck {
  checkedAt: string;
  error: string | null;
  ok: boolean;
  statusCode: number | null;
}

interface DemoPublicationSeed {
  environmentKey: string;
  healthEndpointUrl: string;
  probes: DemoProbeCheck[];
  rawCard: string;
  telemetry?: UpsertPublicationTelemetryRequest;
}

interface DemoAgentSeed {
  capabilities: string[];
  contextContract: CreateDraftAgentRequest["contextContract"];
  displayName: string;
  headerContract: CreateDraftAgentRequest["headerContract"];
  publications: DemoPublicationSeed[];
  requiredRoles: string[];
  requiredScopes: string[];
  summary: string;
  tags: string[];
  versionLabel: string;
}

export interface DemoSeedSummary {
  agentCount: number;
  bootstrapMembershipCount: number;
  bootstrapTenantCount: number;
  probeCount: number;
  publicationCount: number;
  telemetryWindowCount: number;
  tenantId: string;
}

interface DemoSeedContext {
  adminSubjectId: string;
  publisherSubjectId: string;
  tenantId: string;
}

function createRawCard(input: {
  capabilities: string[];
  invocationEndpoint: string;
  name: string;
  summary: string;
  tags: string[];
}): string {
  return JSON.stringify(
    {
      capabilities: input.capabilities,
      invocationEndpoint: input.invocationEndpoint,
      name: input.name,
      summary: input.summary,
      tags: input.tags,
    },
    null,
    2,
  );
}

const demoAgents: DemoAgentSeed[] = [
  {
    capabilities: ["case-resolution", "timeline"],
    contextContract: [
      {
        description: "Selects the client partition to inspect.",
        example: "client-123",
        key: "client_id",
        required: true,
        type: "string",
      },
    ],
    displayName: "Case Resolution Copilot",
    headerContract: [
      {
        description: "Identifies the acting user to the downstream case system.",
        name: "X-User-Id",
        required: true,
        source: "user.id",
      },
    ],
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://case-resolution.dev.example.com/health",
        probes: [
          {
            checkedAt: "2026-01-15T12:00:00.000Z",
            error: null,
            ok: true,
            statusCode: 200,
          },
        ],
        rawCard: createRawCard({
          capabilities: ["case-resolution", "timeline"],
          invocationEndpoint: "https://case-resolution.dev.example.com/invoke",
          name: "Case Resolution Copilot",
          summary: "Guides a support user through case triage and next-step drafting.",
          tags: ["cases", "support"],
        }),
      },
      {
        environmentKey: "prod",
        healthEndpointUrl: "https://case-resolution.prod.example.com/health",
        probes: [
          {
            checkedAt: "2026-01-15T12:00:00.000Z",
            error: null,
            ok: true,
            statusCode: 200,
          },
          {
            checkedAt: "2026-01-15T12:01:00.000Z",
            error: "received 503 from health endpoint",
            ok: false,
            statusCode: 503,
          },
          {
            checkedAt: "2026-01-15T12:02:00.000Z",
            error: null,
            ok: true,
            statusCode: 200,
          },
        ],
        rawCard: createRawCard({
          capabilities: ["case-resolution", "timeline"],
          invocationEndpoint: "https://case-resolution.prod.example.com/invoke",
          name: "Case Resolution Copilot",
          summary: "Guides a support user through case triage and next-step drafting.",
          tags: ["cases", "support"],
        }),
        telemetry: {
          errorCount: 2,
          invocationCount: 24,
          p50LatencyMs: 180,
          p95LatencyMs: 420,
          successCount: 22,
          windowEndedAt: "2026-01-15T13:00:00.000Z",
          windowStartedAt: "2026-01-15T12:00:00.000Z",
        },
      },
    ],
    requiredRoles: ["support-agent"],
    requiredScopes: ["cases.read", "cases.write"],
    summary: "Guides a support user through case triage and next-step drafting.",
    tags: ["cases", "support"],
    versionLabel: "demo-2026.01.15",
  },
  {
    capabilities: ["policy-search", "knowledge-base"],
    contextContract: [
      {
        description: "Selects the policy domain to search before invocation.",
        example: "claims",
        key: "policy_domain",
        required: true,
        type: "string",
      },
    ],
    displayName: "Policy Retrieval Assistant",
    headerContract: [
      {
        description: "Passes the end-user email to the downstream policy search API.",
        name: "X-User-Email",
        required: true,
        source: "user.email",
      },
    ],
    publications: [
      {
        environmentKey: "prod",
        healthEndpointUrl: "https://policy-retrieval.prod.example.com/health",
        probes: [
          {
            checkedAt: "2026-01-15T12:00:00.000Z",
            error: "received 503 from health endpoint",
            ok: false,
            statusCode: 503,
          },
          {
            checkedAt: "2026-01-15T12:01:00.000Z",
            error: "received 503 from health endpoint",
            ok: false,
            statusCode: 503,
          },
          {
            checkedAt: "2026-01-15T12:02:00.000Z",
            error: "received 503 from health endpoint",
            ok: false,
            statusCode: 503,
          },
        ],
        rawCard: createRawCard({
          capabilities: ["policy-search", "knowledge-base"],
          invocationEndpoint: "https://policy-retrieval.prod.example.com/invoke",
          name: "Policy Retrieval Assistant",
          summary: "Finds tenant policy excerpts and cites approved guidance.",
          tags: ["knowledge", "policy"],
        }),
        telemetry: {
          errorCount: 1,
          invocationCount: 11,
          p50LatencyMs: 125,
          p95LatencyMs: 260,
          successCount: 10,
          windowEndedAt: "2026-01-15T13:00:00.000Z",
          windowStartedAt: "2026-01-15T12:00:00.000Z",
        },
      },
    ],
    requiredRoles: ["support-agent"],
    requiredScopes: ["cases.read"],
    summary: "Finds tenant policy excerpts and cites approved guidance.",
    tags: ["knowledge", "policy"],
    versionLabel: "demo-2026.01.15",
  },
];

function createSeedConfigEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    DEPLOYMENT_MODE: env.DEPLOYMENT_MODE ?? "self-hosted",
    SELF_HOSTED_BOOTSTRAP_FILE: env.SELF_HOSTED_BOOTSTRAP_FILE ?? defaultSelfHostedBootstrapFile,
  };
}

function selectManifestSubjectId(
  tenant: BootstrapTenantManifest,
  acceptedRoles: string[],
): string | undefined {
  return (tenant.memberships ?? []).find((membership) =>
    acceptedRoles.some((role) => (membership.roles ?? []).includes(role))
  )?.subjectId;
}

async function loadDemoSeedContext(selfHostedBootstrapFile: string): Promise<DemoSeedContext> {
  const manifest = await loadBootstrapManifest(selfHostedBootstrapFile);

  if (manifest.tenants.length !== 1) {
    throw new Error("Self-hosted seed requires exactly one tenant manifest entry.");
  }

  const [tenant] = manifest.tenants;
  const adminSubjectId = selectManifestSubjectId(tenant, ["tenant-admin"]);

  if (adminSubjectId === undefined) {
    throw new Error(
      "Self-hosted seed requires at least one tenant-admin membership in the bootstrap manifest.",
    );
  }

  const publisherSubjectId = selectManifestSubjectId(tenant, ["publisher", "tenant-admin"]);

  if (publisherSubjectId === undefined) {
    throw new Error(
      "Self-hosted seed requires at least one publisher or tenant-admin membership in the bootstrap manifest.",
    );
  }

  return {
    adminSubjectId,
    publisherSubjectId,
    tenantId: tenant.tenantId,
  };
}

async function resetDemoAgentCatalog(db: AgentRegistryDb, tenantId: string): Promise<void> {
  await db
    .deleteFrom("agents")
    .where("tenant_id", "=", tenantId)
    .where(
      "display_name",
      "in",
      demoAgents.map((agent) => agent.displayName),
    )
    .execute();
}

async function seedDemoAgentCatalog(
  db: AgentRegistryDb,
  context: DemoSeedContext,
): Promise<{
  agentCount: number;
  probeCount: number;
  publicationCount: number;
  telemetryWindowCount: number;
}> {
  const principalResolver = createPrincipalResolver(db);
  const publisher = await principalResolver.resolve({
    auth: {
      subjectId: context.publisherSubjectId,
    },
    tenantId: context.tenantId,
  });
  const admin = await principalResolver.resolve({
    auth: {
      subjectId: context.adminSubjectId,
    },
    tenantId: context.tenantId,
  });
  const draftService = new AgentDraftRegistrationService(
    new KyselyAgentDraftRegistrationRepository(db),
    new KyselyTenantEnvironmentRepository(db),
    new KyselyTenantRepository(db),
    {
      deploymentMode: "self-hosted",
      requireHttpsHealthEndpoints: false,
    },
  );
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(db),
    {
      deploymentMode: "self-hosted",
      requireHttps: false,
      resolveProbeHostname: async () => ["198.51.100.20"],
    },
  );
  const healthRepository = new KyselyHealthRepository(db);
  const telemetryService = new PublicationTelemetryService(
    new KyselyPublicationTelemetryRepository(db),
  );

  let publicationCount = 0;
  let probeCount = 0;
  let telemetryWindowCount = 0;

  for (const demoAgent of demoAgents) {
    const draftRequest: CreateDraftAgentRequest = {
      capabilities: demoAgent.capabilities,
      contextContract: demoAgent.contextContract,
      displayName: demoAgent.displayName,
      headerContract: demoAgent.headerContract,
      publications: demoAgent.publications.map((publication) => ({
        environmentKey: publication.environmentKey,
        healthEndpointUrl: publication.healthEndpointUrl,
        rawCard: publication.rawCard,
      })),
      requiredRoles: demoAgent.requiredRoles,
      requiredScopes: demoAgent.requiredScopes,
      summary: demoAgent.summary,
      tags: demoAgent.tags,
      versionLabel: demoAgent.versionLabel,
    };
    const draft = await draftService.createDraftAgent(publisher, context.tenantId, draftRequest);
    const publicationIds = new Map(
      draft.publications.map((publication) => [publication.environmentKey, publication.publicationId]),
    );

    await reviewService.submitVersion(publisher, context.tenantId, draft.agentId, draft.versionId);
    await reviewService.approveVersion(admin, context.tenantId, draft.agentId, draft.versionId);

    publicationCount += draft.publications.length;

    for (const publication of demoAgent.publications) {
      const publicationId = publicationIds.get(publication.environmentKey);

      if (publicationId === undefined) {
        throw new Error(
          `Expected publication '${publication.environmentKey}' for seeded agent '${demoAgent.displayName}'.`,
        );
      }

      for (const probe of publication.probes) {
        await healthRepository.recordPublicationProbe({
          ...probe,
          publicationId,
        });
        probeCount += 1;
      }

      if (publication.telemetry !== undefined) {
        await telemetryService.upsertTelemetry(
          publisher,
          context.tenantId,
          draft.agentId,
          draft.versionId,
          publication.environmentKey,
          publication.telemetry,
        );
        telemetryWindowCount += 1;
      }
    }
  }

  return {
    agentCount: demoAgents.length,
    probeCount,
    publicationCount,
    telemetryWindowCount,
  };
}

export async function seedDemoRegistry(env: NodeJS.ProcessEnv = process.env): Promise<DemoSeedSummary> {
  const config = loadRegistryConfig(createSeedConfigEnv(env));

  if (config.deploymentMode !== "self-hosted") {
    throw new Error("Demo seed data is only supported when DEPLOYMENT_MODE=self-hosted.");
  }

  const selfHostedBootstrapFile = config.bootstrap.selfHostedBootstrapFile;

  if (selfHostedBootstrapFile === undefined) {
    throw new Error("Self-hosted seed requires a bootstrap manifest.");
  }

  const seedContext = await loadDemoSeedContext(selfHostedBootstrapFile);

  const db = createKyselyDb(config.databaseUrl);

  try {
    await normalizeLegacyTelemetryMigrationRows(db);
    await migrateToLatest(db);

    const bootstrapSummary = await bootstrapFromConfig(
      config,
      new KyselyBootstrapRepository(db),
    );

    if (bootstrapSummary === null) {
      throw new Error("Self-hosted seed requires a bootstrap manifest.");
    }

    await resetDemoAgentCatalog(db, seedContext.tenantId);

    const catalogSummary = await seedDemoAgentCatalog(db, seedContext);

    return {
      ...catalogSummary,
      bootstrapMembershipCount: bootstrapSummary.membershipCount,
      bootstrapTenantCount: bootstrapSummary.tenantCount,
      tenantId: seedContext.tenantId,
    };
  } finally {
    await destroyKyselyDb(db);
  }
}

export async function seedDemoRegistryFromCli(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const summary = await seedDemoRegistry(env);

  console.log(
    `Seeded demo tenant '${summary.tenantId}' with ${summary.agentCount} agents, ${summary.publicationCount} publications, ${summary.probeCount} probe checks, and ${summary.telemetryWindowCount} telemetry windows.`,
  );
}

export { defaultSelfHostedBootstrapFile };
