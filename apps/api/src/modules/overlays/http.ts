import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  type PrincipalResolver,
} from "@agent-registry/auth";
import {
  AgentEnvironmentPublicationNotFoundError,
  AgentNotFoundError,
} from "@agent-registry/db";

import {
  TenantPolicyOverlayAuthorizationError,
  TenantPolicyOverlayService,
} from "./service.js";

type OverlayAction = "deprecate" | "disable";

export type TenantPolicyOverlayRouteMatch =
  | {
      action: OverlayAction;
      agentId: string;
      environmentKey: string;
      tenantId: string;
      type: "environment";
    }
  | {
      action: OverlayAction;
      agentId: string;
      tenantId: string;
      type: "agent";
    };

export interface TenantPolicyOverlayHttpDependencies {
  principalResolver: PrincipalResolver;
  service: TenantPolicyOverlayService;
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

export function matchTenantPolicyOverlayRoute(
  pathname: string,
): TenantPolicyOverlayRouteMatch | null {
  const environmentMatch =
    /^\/tenants\/([^/]+)\/agents\/([^/]+)\/environments\/([^/:]+):(disable|deprecate)\/?$/.exec(
      pathname,
    );

  if (environmentMatch !== null) {
    return {
      action: environmentMatch[4] as OverlayAction,
      agentId: decodeURIComponent(environmentMatch[2]),
      environmentKey: decodeURIComponent(environmentMatch[3]),
      tenantId: decodeURIComponent(environmentMatch[1]),
      type: "environment",
    };
  }

  const agentMatch = /^\/tenants\/([^/]+)\/agents\/([^/:]+):(disable|deprecate)\/?$/.exec(pathname);

  if (agentMatch !== null) {
    return {
      action: agentMatch[3] as OverlayAction,
      agentId: decodeURIComponent(agentMatch[2]),
      tenantId: decodeURIComponent(agentMatch[1]),
      type: "agent",
    };
  }

  return null;
}

export async function handleTenantPolicyOverlayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: TenantPolicyOverlayRouteMatch,
  dependencies: TenantPolicyOverlayHttpDependencies,
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

    if (route.type === "agent") {
      writeJson(
        response,
        200,
        route.action === "disable"
          ? await dependencies.service.disableAgent(principal, route.tenantId, route.agentId)
          : await dependencies.service.deprecateAgent(principal, route.tenantId, route.agentId),
      );
      return;
    }

    writeJson(
      response,
      200,
      route.action === "disable"
        ? await dependencies.service.disableEnvironment(
            principal,
            route.tenantId,
            route.agentId,
            route.environmentKey,
          )
        : await dependencies.service.deprecateEnvironment(
            principal,
            route.tenantId,
            route.agentId,
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

    if (error instanceof TenantPolicyOverlayAuthorizationError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof AgentNotFoundError) {
      writeError(response, 404, "agent_not_found", error.message);
      return;
    }

    if (error instanceof AgentEnvironmentPublicationNotFoundError) {
      writeError(response, 404, "environment_not_found", error.message);
      return;
    }

    if (error instanceof Error) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
