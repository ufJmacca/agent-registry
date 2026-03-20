import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  type PrincipalResolver,
} from "@agent-registry/auth";
import {
  AgentNotFoundError,
  AgentVersionNotFoundError,
} from "@agent-registry/db";

import {
  AgentAdminDetailAuthorizationError,
  AgentAdminDetailService,
} from "./service.js";

export type AgentAdminDetailRouteMatch =
  | {
      agentId: string;
      tenantId: string;
      type: "version";
      versionId: string;
    }
  | {
      agentId: string;
      tenantId: string;
      type: "agent";
    };

export interface AgentAdminDetailHttpDependencies {
  principalResolver: PrincipalResolver;
  service: AgentAdminDetailService;
}

export class InvalidAgentAdminDetailRequestError extends Error {}

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
    throw new InvalidAgentAdminDetailRequestError(errorMessage);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidAgentAdminDetailRequestError(errorMessage);
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
    throw new InvalidAgentAdminDetailRequestError(`${label} path segment must be valid URL encoding.`);
  }
}

export function matchAgentAdminDetailRoute(pathname: string): AgentAdminDetailRouteMatch | null {
  const versionMatch = /^\/tenants\/([^/]+)\/agents\/([^/]+)\/versions\/([^/]+)\/?$/.exec(pathname);

  if (versionMatch !== null) {
    return {
      agentId: decodeRouteSegment(versionMatch[2], "Agent id"),
      tenantId: decodeRouteSegment(versionMatch[1], "Tenant id"),
      type: "version",
      versionId: decodeRouteSegment(versionMatch[3], "Version id"),
    };
  }

  const agentMatch = /^\/tenants\/([^/]+)\/agents\/([^/]+):admin-detail\/?$/.exec(pathname);

  if (agentMatch !== null) {
    return {
      agentId: decodeRouteSegment(agentMatch[2], "Agent id"),
      tenantId: decodeRouteSegment(agentMatch[1], "Tenant id"),
      type: "agent",
    };
  }

  return null;
}

export async function handleAgentAdminDetailRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: AgentAdminDetailRouteMatch,
  dependencies: AgentAdminDetailHttpDependencies,
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

    if (route.type === "agent") {
      writeJson(
        response,
        200,
        await dependencies.service.getAgentDetail(principal, route.tenantId, route.agentId),
      );
      return;
    }

    writeJson(
      response,
      200,
      await dependencies.service.getVersionDetail(
        principal,
        route.tenantId,
        route.agentId,
        route.versionId,
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

    if (error instanceof AgentAdminDetailAuthorizationError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof AgentNotFoundError) {
      writeError(response, 404, "agent_not_found", error.message);
      return;
    }

    if (error instanceof AgentVersionNotFoundError) {
      writeError(response, 404, "version_not_found", error.message);
      return;
    }

    if (error instanceof InvalidAgentAdminDetailRequestError) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
