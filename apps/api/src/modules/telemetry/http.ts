import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  type PrincipalResolver,
} from "@agent-registry/auth";
import type { UpsertPublicationTelemetryRequest } from "@agent-registry/contracts";
import {
  AgentVersionEnvironmentPublicationNotFoundError,
  AgentVersionNotFoundError,
} from "@agent-registry/db";

import {
  PublicationTelemetryAuthorizationError,
  PublicationTelemetryService,
  PublicationTelemetryValidationError,
} from "./service.js";

export interface PublicationTelemetryRouteMatch {
  agentId: string;
  environmentKey: string;
  tenantId: string;
  versionId: string;
}

export interface PublicationTelemetryHttpDependencies {
  principalResolver: PrincipalResolver;
  service: PublicationTelemetryService;
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

async function readTelemetryRequest(
  request: IncomingMessage,
): Promise<UpsertPublicationTelemetryRequest> {
  const body = (await readRequestBody(request)).trim();

  if (body === "") {
    throw new Error("Request body must be a JSON object.");
  }

  return parseJsonObject(body, "Request body must be a JSON object.") as unknown as UpsertPublicationTelemetryRequest;
}

export function matchPublicationTelemetryRoute(
  pathname: string,
): PublicationTelemetryRouteMatch | null {
  const match =
    /^\/tenants\/([^/]+)\/agents\/([^/]+)\/versions\/([^/]+)\/environments\/([^/:]+):telemetry\/?$/.exec(
      pathname,
    );

  if (match === null) {
    return null;
  }

  return {
    agentId: decodeURIComponent(match[2]),
    environmentKey: decodeURIComponent(match[4]),
    tenantId: decodeURIComponent(match[1]),
    versionId: decodeURIComponent(match[3]),
  };
}

export async function handlePublicationTelemetryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: PublicationTelemetryRouteMatch,
  dependencies: PublicationTelemetryHttpDependencies,
): Promise<void> {
  try {
    const principal = await dependencies.principalResolver.resolve({
      auth: {
        subjectId: readHeader(request, "x-agent-registry-subject-id"),
        userContext: parseOptionalUserContext(request),
      },
      tenantId: route.tenantId,
    });

    if (request.method !== "POST") {
      writeError(response, 405, "method_not_allowed", "Method not allowed.", {
        allow: "POST",
      });
      return;
    }

    writeJson(
      response,
      200,
      await dependencies.service.upsertTelemetry(
        principal,
        route.tenantId,
        route.agentId,
        route.versionId,
        route.environmentKey,
        await readTelemetryRequest(request),
      ),
    );
  } catch (error) {
    if (error instanceof MissingSubjectIdError) {
      writeError(response, 401, "unauthorized", error.message);
      return;
    }

    if (error instanceof MissingTenantMembershipError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof PublicationTelemetryAuthorizationError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof AgentVersionNotFoundError) {
      writeError(response, 404, "version_not_found", error.message);
      return;
    }

    if (error instanceof AgentVersionEnvironmentPublicationNotFoundError) {
      writeError(response, 404, "environment_not_found", error.message);
      return;
    }

    if (error instanceof PublicationTelemetryValidationError) {
      writeError(response, 400, "invalid_telemetry_request", error.message);
      return;
    }

    if (error instanceof Error) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
