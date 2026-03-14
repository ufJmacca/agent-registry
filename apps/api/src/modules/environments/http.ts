import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  type PrincipalResolver,
} from "@agent-registry/auth";
import type { CreateTenantEnvironmentRequest } from "@agent-registry/contracts";

import {
  EnvironmentCatalogAuthorizationError,
  EnvironmentCatalogDuplicateError,
  EnvironmentCatalogValidationError,
  TenantEnvironmentCatalogService,
} from "./service.js";

export interface TenantEnvironmentRouteMatch {
  tenantId: string;
}

export interface TenantEnvironmentHttpDependencies {
  principalResolver: PrincipalResolver;
  service: TenantEnvironmentCatalogService;
}

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  };
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  const body: ErrorResponseBody = {
    error: {
      code,
      message,
    },
  };

  writeJson(response, statusCode, body, headers);
}

function readHeader(request: IncomingMessage, headerName: string): string | undefined {
  const value = request.headers[headerName];

  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function parseJsonObject(value: string, errorMessage: string): Record<string, unknown> {
  const parsed = JSON.parse(value);

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(errorMessage);
  }

  return parsed as Record<string, unknown>;
}

function parseOptionalUserContext(request: IncomingMessage): Record<string, unknown> | undefined {
  const rawUserContext = readHeader(request, "x-agent-registry-user-context");

  if (rawUserContext === undefined) {
    return undefined;
  }

  return parseJsonObject(
    rawUserContext,
    "The x-agent-registry-user-context header must be a JSON object.",
  );
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";

  for await (const chunk of request) {
    body += chunk.toString();
  }

  return body;
}

async function readCreateEnvironmentRequest(
  request: IncomingMessage,
): Promise<CreateTenantEnvironmentRequest> {
  const body = (await readRequestBody(request)).trim();

  if (body === "") {
    throw new Error("Request body must be a JSON object with an environmentKey string.");
  }

  const parsed = parseJsonObject(body, "Request body must be a JSON object.");
  const environmentKey = parsed.environmentKey;

  if (typeof environmentKey !== "string") {
    throw new Error("Request body must be a JSON object with an environmentKey string.");
  }

  return {
    environmentKey,
  };
}

export function matchTenantEnvironmentRoute(pathname: string): TenantEnvironmentRouteMatch | null {
  const match = /^\/tenants\/([^/]+)\/environments\/?$/.exec(pathname);

  if (match === null) {
    return null;
  }

  return {
    tenantId: decodeURIComponent(match[1]),
  };
}

export async function handleTenantEnvironmentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: TenantEnvironmentRouteMatch,
  dependencies: TenantEnvironmentHttpDependencies,
): Promise<void> {
  try {
    const principal = await dependencies.principalResolver.resolve({
      auth: {
        subjectId: readHeader(request, "x-agent-registry-subject-id"),
        userContext: parseOptionalUserContext(request),
      },
      tenantId: route.tenantId,
    });

    if (request.method === "GET") {
      writeJson(response, 200, await dependencies.service.listEnvironments(principal, route.tenantId));
      return;
    }

    if (request.method === "POST") {
      const createRequest = await readCreateEnvironmentRequest(request);
      writeJson(
        response,
        201,
        await dependencies.service.createEnvironment(principal, route.tenantId, createRequest),
      );
      return;
    }

    writeError(response, 405, "method_not_allowed", "Method not allowed.", {
      allow: "GET, POST",
    });
  } catch (error) {
    if (error instanceof MissingSubjectIdError) {
      writeError(response, 401, "unauthorized", error.message);
      return;
    }

    if (error instanceof MissingTenantMembershipError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof EnvironmentCatalogAuthorizationError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof EnvironmentCatalogDuplicateError) {
      writeError(response, 409, "duplicate_environment", error.message);
      return;
    }

    if (error instanceof EnvironmentCatalogValidationError) {
      writeError(response, 400, "invalid_environment_key", error.message);
      return;
    }

    if (error instanceof Error) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
