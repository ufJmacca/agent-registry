import http from "node:http";

import { loadRegistryConfig, type RegistryConfig } from "@agent-registry/config";
import {
  KyselyAgentAdminDetailRepository,
  KyselyAgentDiscoveryRepository,
  KyselyAgentDraftRegistrationRepository,
  KyselyAgentReviewRepository,
  KyselyHealthRepository,
  KyselyPublicationTelemetryRepository,
  KyselyTenantEnvironmentRepository,
  KyselyTenantPolicyOverlayRepository,
  KyselyTenantRepository,
  type AgentRegistryDb,
} from "@agent-registry/db";

import { createPrincipalResolver } from "./auth/index.js";
import {
  AgentDiscoveryService,
  handleDiscoveryRequest,
  matchDiscoveryRoute,
} from "./modules/discovery/index.js";
import {
  AgentPublicationDetailService,
  handleAgentDetailRequest,
  matchAgentDetailRoute,
} from "./modules/detail/index.js";
import {
  AgentAdminDetailService,
  handleAgentAdminDetailRequest,
  matchAgentAdminDetailRoute,
} from "./modules/admin-detail/index.js";
import {
  AgentPublicationHealthService,
  handleAgentPublicationHealthRequest,
  matchAgentPublicationHealthRoute,
} from "./modules/health/index.js";
import {
  AgentDraftRegistrationService,
  handleAgentDraftRequest,
  matchAgentDraftRoute,
} from "./modules/agents/index.js";
import {
  TenantEnvironmentCatalogService,
  handleTenantEnvironmentRequest,
  matchTenantEnvironmentRoute,
} from "./modules/environments/index.js";
import {
  handleTenantPolicyOverlayRequest,
  matchTenantPolicyOverlayRoute,
  TenantPolicyOverlayService,
} from "./modules/overlays/index.js";
import {
  handleSearchRequest,
  matchSearchRoute,
} from "./modules/search/index.js";
import {
  AgentPublicationPreflightService,
  handleAgentPublicationPreflightRequest,
  matchAgentPublicationPreflightRoute,
} from "./modules/preflight/index.js";
import {
  handlePublicationTelemetryRequest,
  matchPublicationTelemetryRoute,
  PublicationTelemetryService,
} from "./modules/telemetry/index.js";
import {
  type AgentVersionReviewServiceOptions,
  AgentVersionReviewService,
  handleAgentVersionReviewRequest,
  matchAgentVersionReviewRoute,
} from "./modules/review/index.js";

function writeJson(
  response: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

export interface ApiRequestListenerOptions {
  config?: Pick<RegistryConfig, "deploymentMode" | "healthProbe" | "rawCardByteLimit">;
  db: AgentRegistryDb;
  reviewServiceOptions?: Pick<AgentVersionReviewServiceOptions, "resolveProbeHostname">;
}

export function createApiRequestListener(options: ApiRequestListenerOptions): http.RequestListener {
  const config = options.config ?? loadRegistryConfig(process.env, { requireBootstrapFile: false });
  const principalResolver = createPrincipalResolver(options.db);
  const environmentRepository = new KyselyTenantEnvironmentRepository(options.db);
  const tenantRepository = new KyselyTenantRepository(options.db);
  const publicationRepository = new KyselyAgentDiscoveryRepository(options.db);
  const environmentService = new TenantEnvironmentCatalogService(environmentRepository);
  const agentDraftService = new AgentDraftRegistrationService(
    new KyselyAgentDraftRegistrationRepository(options.db),
    environmentRepository,
    tenantRepository,
    {
      deploymentMode: config.deploymentMode,
      rawCardByteLimit: config.rawCardByteLimit,
      requireHttpsHealthEndpoints: config.healthProbe.requireHttps,
    },
  );
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(options.db),
    {
      allowPrivateTargets: config.healthProbe.allowPrivateTargets,
      deploymentMode: config.deploymentMode,
      requireHttps: config.healthProbe.requireHttps,
      ...options.reviewServiceOptions,
    },
  );
  const discoveryService = new AgentDiscoveryService(
    publicationRepository,
    {
      rawCardByteLimit: config.rawCardByteLimit,
    },
  );
  const overlayService = new TenantPolicyOverlayService(
    new KyselyTenantPolicyOverlayRepository(options.db),
  );
  const telemetryService = new PublicationTelemetryService(
    new KyselyPublicationTelemetryRepository(options.db),
  );
  const adminDetailService = new AgentAdminDetailService(
    new KyselyAgentAdminDetailRepository(options.db),
  );
  const detailService = new AgentPublicationDetailService(publicationRepository);
  const preflightService = new AgentPublicationPreflightService(publicationRepository);
  const healthService = new AgentPublicationHealthService(
    new KyselyHealthRepository(options.db),
  );

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const adminDetailRoute = matchAgentAdminDetailRoute(url.pathname);
    const detailRoute = matchAgentDetailRoute(url.pathname);
    const discoveryRoute = matchDiscoveryRoute(url.pathname);
    const agentDraftRoute = matchAgentDraftRoute(url.pathname);
    const environmentRoute = matchTenantEnvironmentRoute(url.pathname);
    const healthRoute = matchAgentPublicationHealthRoute(url.pathname);
    const overlayRoute = matchTenantPolicyOverlayRoute(url.pathname);
    const preflightRoute = matchAgentPublicationPreflightRoute(url.pathname);
    const telemetryRoute = matchPublicationTelemetryRoute(url.pathname);
    const reviewRoute = matchAgentVersionReviewRoute(url.pathname);
    const searchRoute = matchSearchRoute(url.pathname);

    if (reviewRoute !== null) {
      await handleAgentVersionReviewRequest(request, response, reviewRoute, {
        principalResolver,
        service: reviewService,
      });
      return;
    }

    if (preflightRoute !== null) {
      await handleAgentPublicationPreflightRequest(request, response, preflightRoute, {
        principalResolver,
        service: preflightService,
      });
      return;
    }

    if (healthRoute !== null) {
      await handleAgentPublicationHealthRequest(request, response, healthRoute, {
        principalResolver,
        service: healthService,
      });
      return;
    }

    if (overlayRoute !== null) {
      await handleTenantPolicyOverlayRequest(request, response, overlayRoute, {
        principalResolver,
        service: overlayService,
      });
      return;
    }

    if (searchRoute !== null) {
      await handleSearchRequest(request, response, searchRoute, {
        principalResolver,
        service: discoveryService,
      });
      return;
    }

    if (discoveryRoute !== null) {
      await handleDiscoveryRequest(request, response, discoveryRoute, {
        principalResolver,
        service: discoveryService,
      });
      return;
    }

    if (detailRoute !== null) {
      await handleAgentDetailRequest(request, response, detailRoute, {
        adminDetailService,
        principalResolver,
        service: detailService,
      });
      return;
    }

    if (telemetryRoute !== null) {
      await handlePublicationTelemetryRequest(request, response, telemetryRoute, {
        principalResolver,
        service: telemetryService,
      });
      return;
    }

    if (agentDraftRoute !== null) {
      await handleAgentDraftRequest(request, response, agentDraftRoute, {
        principalResolver,
        service: agentDraftService,
      });
      return;
    }

    if (environmentRoute !== null) {
      await handleTenantEnvironmentRequest(request, response, environmentRoute, {
        principalResolver,
        service: environmentService,
      });
      return;
    }

    if (adminDetailRoute !== null) {
      await handleAgentAdminDetailRequest(request, response, adminDetailRoute, {
        principalResolver,
        service: adminDetailService,
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/") {
      writeJson(response, 200, {
        service: "api",
        status: "ok",
        summary: "REST API for the agent registry.",
      });
      return;
    }

    writeJson(response, 404, {
      error: {
        code: "not_found",
        message: "Route not found.",
      },
    });
  };
}
