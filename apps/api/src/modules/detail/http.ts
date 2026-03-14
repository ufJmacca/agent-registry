import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  hasAnyRole,
  type PrincipalResolver,
} from "@agent-registry/auth";
import {
  ActiveAgentPublicationNotFoundError,
  AgentEnvironmentPublicationNotFoundError,
  AgentNotFoundError,
} from "@agent-registry/db";

import {
  AgentAdminDetailAuthorizationError,
  AgentAdminDetailService,
} from "../admin-detail/service.js";
import {
  AgentPublicationDetailAuthorizationError,
  AgentPublicationDetailService,
  AgentPublicationDetailValidationError,
  type AgentPublicationDetailQuery,
} from "./service.js";

export interface AgentDetailRouteMatch {
  agentId: string;
  tenantId: string;
}

export interface AgentDetailHttpDependencies {
  adminDetailService: AgentAdminDetailService;
  principalResolver: PrincipalResolver;
  service: AgentPublicationDetailService;
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

function parseIncludeRawCard(searchParams: URLSearchParams): boolean {
  const includes = searchParams.getAll("include");

  for (const include of includes) {
    if (include !== "rawCard") {
      throw new AgentPublicationDetailValidationError(
        `Unsupported include value '${include}'.`,
      );
    }
  }

  return includes.includes("rawCard");
}

function parseDetailQuery(searchParams: URLSearchParams): AgentPublicationDetailQuery {
  const environmentKeys = searchParams.getAll("environmentKey");

  if (environmentKeys.length > 1) {
    throw new AgentPublicationDetailValidationError(
      "environmentKey may only be specified once.",
    );
  }

  return {
    environmentKey: environmentKeys[0] ?? null,
    includeRawCard: parseIncludeRawCard(searchParams),
  };
}

export function matchAgentDetailRoute(pathname: string): AgentDetailRouteMatch | null {
  const match = /^\/tenants\/([^/]+)\/agents\/([^/]+)\/?$/.exec(pathname);

  if (match === null) {
    return null;
  }

  return {
    agentId: decodeURIComponent(match[2]),
    tenantId: decodeURIComponent(match[1]),
  };
}

export async function handleAgentDetailRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: AgentDetailRouteMatch,
  dependencies: AgentDetailHttpDependencies,
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

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const query = parseDetailQuery(url.searchParams);

    if (
      hasAnyRole(principal.roles, ["tenant-admin"]) &&
      query.environmentKey === null &&
      !query.includeRawCard
    ) {
      writeJson(
        response,
        200,
        await dependencies.adminDetailService.getAgentDetail(principal, route.tenantId, route.agentId),
      );
      return;
    }

    writeJson(
      response,
      200,
      await dependencies.service.getPublicationDetail(principal, route.tenantId, route.agentId, query),
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

    if (
      error instanceof AgentAdminDetailAuthorizationError ||
      error instanceof AgentPublicationDetailAuthorizationError
    ) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (
      error instanceof ActiveAgentPublicationNotFoundError ||
      error instanceof AgentEnvironmentPublicationNotFoundError
    ) {
      writeError(response, 404, "publication_not_found", error.message);
      return;
    }

    if (error instanceof AgentNotFoundError) {
      writeError(response, 404, "agent_not_found", error.message);
      return;
    }

    if (error instanceof AgentPublicationDetailValidationError) {
      writeError(response, 400, "invalid_query", error.message);
      return;
    }

    if (error instanceof Error) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
