import http from "node:http";

import { KyselyTenantEnvironmentRepository, type AgentRegistryDb } from "@agent-registry/db";

import { createPrincipalResolver } from "./auth/index.js";
import {
  TenantEnvironmentCatalogService,
  handleTenantEnvironmentRequest,
  matchTenantEnvironmentRoute,
} from "./modules/environments/index.js";

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
  db: AgentRegistryDb;
}

export function createApiRequestListener(options: ApiRequestListenerOptions): http.RequestListener {
  const principalResolver = createPrincipalResolver(options.db);
  const environmentService = new TenantEnvironmentCatalogService(
    new KyselyTenantEnvironmentRepository(options.db),
  );

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const environmentRoute = matchTenantEnvironmentRoute(url.pathname);

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

    writeJson(response, 404, {
      error: {
        code: "not_found",
        message: "Route not found.",
      },
    });
  };
}
