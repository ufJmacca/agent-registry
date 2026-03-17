import http from "node:http";

import { KyselyTenantEnvironmentRepository, type AgentRegistryDb } from "@agent-registry/db";

import { createPrincipalResolver } from "./auth/index.js";
import {
  InvalidTenantEnvironmentRequestError,
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
  db: AgentRegistryDb;
}

export function createApiRequestListener(options: ApiRequestListenerOptions): http.RequestListener {
  const principalResolver = createPrincipalResolver(options.db);
  const environmentService = new TenantEnvironmentCatalogService(
    new KyselyTenantEnvironmentRepository(options.db),
  );

  return async (request, response) => {
    try {
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

      writeError(response, 404, "not_found", "Route not found.");
    } catch (error) {
      if (error instanceof InvalidTenantEnvironmentRequestError) {
        writeError(response, 400, "invalid_request", error.message);
        return;
      }

      writeError(response, 500, "internal_error", "Internal server error.");
    }
  };
}
