import http from "node:http";

import { loadRegistryConfig, type RegistryConfig } from "@agent-registry/config";
import {
  KyselyAgentAdminDetailRepository,
  KyselyAgentDiscoveryRepository,
  KyselyAgentDraftRegistrationRepository,
  KyselyAgentReviewRepository,
  KyselyTenantEnvironmentRepository,
  KyselyTenantPolicyOverlayRepository,
  KyselyTenantRepository,
  type AgentRegistryDb,
} from "@agent-registry/db";

import { createPrincipalResolver } from "./auth/index.js";
import {
  AgentAdminDetailService,
  InvalidAgentAdminDetailRequestError,
  handleAgentAdminDetailRequest,
  matchAgentAdminDetailRoute,
} from "./modules/admin-detail/index.js";
import {
  AgentDraftRegistrationService,
  InvalidAgentDraftRequestError,
  handleAgentDraftRequest,
  matchAgentDraftRoute,
} from "./modules/agents/index.js";
import {
  AgentPublicationDetailService,
  InvalidAgentDetailRequestError,
  handleAgentDetailRequest,
  matchAgentDetailRoute,
} from "./modules/detail/index.js";
import {
  AgentDiscoveryService,
  InvalidDiscoveryRequestError,
  handleDiscoveryRequest,
  matchDiscoveryRoute,
} from "./modules/discovery/index.js";
import {
  InvalidTenantEnvironmentRequestError,
  TenantEnvironmentCatalogService,
  handleTenantEnvironmentRequest,
  matchTenantEnvironmentRoute,
} from "./modules/environments/index.js";
import {
  InvalidTenantPolicyOverlayRequestError,
  TenantPolicyOverlayService,
  handleTenantPolicyOverlayRequest,
  matchTenantPolicyOverlayRoute,
} from "./modules/overlays/index.js";
import {
  AgentPublicationPreflightService,
  InvalidAgentPublicationPreflightRequestError,
  handleAgentPublicationPreflightRequest,
  matchAgentPublicationPreflightRoute,
} from "./modules/preflight/index.js";
import {
  AgentVersionReviewService,
  InvalidAgentVersionReviewRequestError,
  type AgentVersionReviewServiceOptions,
  handleAgentVersionReviewRequest,
  matchAgentVersionReviewRoute,
} from "./modules/review/index.js";
import {
  InvalidSearchRequestError,
  handleSearchRequest,
  matchSearchRoute,
} from "./modules/search/index.js";

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

function writeError(
  response: http.ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  writeJson(response, statusCode, {
    error: {
      code,
      message,
    },
  });
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
  const adminDetailService = new AgentAdminDetailService(
    new KyselyAgentAdminDetailRepository(options.db),
  );
  const detailService = new AgentPublicationDetailService(publicationRepository);
  const preflightService = new AgentPublicationPreflightService(publicationRepository);

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const reviewRoute = matchAgentVersionReviewRoute(url.pathname);
      const overlayRoute = matchTenantPolicyOverlayRoute(url.pathname);
      const searchRoute = matchSearchRoute(url.pathname);
      const discoveryRoute = matchDiscoveryRoute(url.pathname);
      const preflightRoute = matchAgentPublicationPreflightRoute(url.pathname);
      const detailRoute = matchAgentDetailRoute(url.pathname);
      const agentDraftRoute = matchAgentDraftRoute(url.pathname);
      const environmentRoute = matchTenantEnvironmentRoute(url.pathname);
      const adminDetailRoute = matchAgentAdminDetailRoute(url.pathname);

      if (reviewRoute !== null) {
        await handleAgentVersionReviewRequest(request, response, reviewRoute, {
          principalResolver,
          service: reviewService,
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

      if (preflightRoute !== null) {
        await handleAgentPublicationPreflightRequest(request, response, preflightRoute, {
          principalResolver,
          service: preflightService,
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

      if (detailRoute !== null) {
        await handleAgentDetailRequest(request, response, detailRoute, {
          principalResolver,
          service: detailService,
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

      if (request.method === "GET" && url.pathname === "/") {
        writeJson(response, 200, {
          service: "api",
          status: "ok",
          summary: "REST API for the agent registry.",
        });
        return;
      }

      writeError(response, 404, "not_found", "Route not found.");
    } catch (error) {
      if (
        error instanceof InvalidAgentAdminDetailRequestError ||
        error instanceof InvalidAgentDetailRequestError ||
        error instanceof InvalidAgentDraftRequestError ||
        error instanceof InvalidAgentPublicationPreflightRequestError ||
        error instanceof InvalidAgentVersionReviewRequestError ||
        error instanceof InvalidDiscoveryRequestError ||
        error instanceof InvalidSearchRequestError ||
        error instanceof InvalidTenantEnvironmentRequestError ||
        error instanceof InvalidTenantPolicyOverlayRequestError
      ) {
        writeError(response, 400, "invalid_request", error.message);
        return;
      }

      writeError(response, 500, "internal_error", "Internal server error.");
    }
  };
}
