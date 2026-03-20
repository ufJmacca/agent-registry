import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  type PrincipalResolver,
} from "@agent-registry/auth";
import { PublicationHealthNotFoundError } from "@agent-registry/db";

import {
  AgentPublicationHealthAuthorizationError,
  AgentPublicationHealthService,
} from "./service.js";

export interface AgentPublicationHealthRouteMatch {
  agentId: string;
  environmentKey: string;
  tenantId: string;
  versionId: string;
}

export interface AgentPublicationHealthHttpDependencies {
  principalResolver: PrincipalResolver;
  service: AgentPublicationHealthService;
}

export class InvalidAgentPublicationHealthRequestError extends Error {}

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
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new InvalidAgentPublicationHealthRequestError(errorMessage);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidAgentPublicationHealthRequestError(errorMessage);
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

function decodeRouteSegment(segment: string, label: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new InvalidAgentPublicationHealthRequestError(
      `${label} path segment must be valid URL encoding.`,
    );
  }
}

export function matchAgentPublicationHealthRoute(
  pathname: string,
): AgentPublicationHealthRouteMatch | null {
  const match =
    /^\/tenants\/([^/]+)\/agents\/([^/]+)\/versions\/([^/]+)\/environments\/([^/]+)\/health\/?$/.exec(
      pathname,
    );

  if (match === null) {
    return null;
  }

  return {
    agentId: decodeRouteSegment(match[2], "Agent id"),
    environmentKey: decodeRouteSegment(match[4], "Environment key"),
    tenantId: decodeRouteSegment(match[1], "Tenant id"),
    versionId: decodeRouteSegment(match[3], "Version id"),
  };
}

export async function handleAgentPublicationHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: AgentPublicationHealthRouteMatch,
  dependencies: AgentPublicationHealthHttpDependencies,
): Promise<void> {
  try {
    const principal = await dependencies.principalResolver.resolve({
      auth: {
        subjectId: readHeader(request, "x-agent-registry-subject-id"),
        userContext: parseOptionalUserContext(request),
      },
      tenantId: route.tenantId,
    });

    if (request.method !== "GET") {
      writeError(response, 405, "method_not_allowed", "Method not allowed.", {
        allow: "GET",
      });
      return;
    }

    writeJson(
      response,
      200,
      await dependencies.service.getPublicationHealth(
        principal,
        route.tenantId,
        route.agentId,
        route.versionId,
        route.environmentKey,
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

    if (error instanceof AgentPublicationHealthAuthorizationError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof PublicationHealthNotFoundError) {
      writeError(response, 404, "publication_health_not_found", error.message);
      return;
    }

    if (error instanceof InvalidAgentPublicationHealthRequestError) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
