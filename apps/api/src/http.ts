import http from "node:http";

import { loadRegistryConfig, type RegistryConfig } from "@agent-registry/config";
import {
  KyselyAgentAdminDetailRepository,
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
  AgentVersionReviewService,
  InvalidAgentVersionReviewRequestError,
  type AgentVersionReviewServiceOptions,
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
  const overlayService = new TenantPolicyOverlayService(
    new KyselyTenantPolicyOverlayRepository(options.db),
  );
  const adminDetailService = new AgentAdminDetailService(
    new KyselyAgentAdminDetailRepository(options.db),
  );

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const reviewRoute = matchAgentVersionReviewRoute(url.pathname);
      const overlayRoute = matchTenantPolicyOverlayRoute(url.pathname);
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

      writeError(response, 404, "not_found", "Route not found.");
    } catch (error) {
      if (
        error instanceof InvalidAgentAdminDetailRequestError ||
        error instanceof InvalidAgentDraftRequestError ||
        error instanceof InvalidAgentVersionReviewRequestError ||
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
