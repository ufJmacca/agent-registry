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
  handleAgentAdminDetailRequest,
  matchAgentAdminDetailRoute,
} from "./modules/admin-detail/index.js";
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
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const adminDetailRoute = matchAgentAdminDetailRoute(url.pathname);
    const agentDraftRoute = matchAgentDraftRoute(url.pathname);
    const environmentRoute = matchTenantEnvironmentRoute(url.pathname);
    const overlayRoute = matchTenantPolicyOverlayRoute(url.pathname);
    const reviewRoute = matchAgentVersionReviewRoute(url.pathname);

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

    writeJson(response, 404, {
      error: {
        code: "not_found",
        message: "Route not found.",
      },
    });
  };
}
