import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  type PrincipalResolver,
} from "@agent-registry/auth";
import type { AgentPublicationPreflightRequest } from "@agent-registry/contracts";
import { AgentEnvironmentPublicationNotFoundError } from "@agent-registry/db";

import {
  AgentPublicationPreflightAuthorizationError,
  AgentPublicationPreflightService,
} from "./service.js";

export interface AgentPublicationPreflightRouteMatch {
  agentId: string;
  environmentKey: string;
  tenantId: string;
}

export interface AgentPublicationPreflightHttpDependencies {
  principalResolver: PrincipalResolver;
  service: AgentPublicationPreflightService;
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

function parseIncludeRawCard(searchParams: URLSearchParams): boolean {
  const includes = searchParams.getAll("include");

  for (const include of includes) {
    if (include !== "rawCard") {
      throw new Error(`Unsupported include value '${include}'.`);
    }
  }

  return includes.includes("rawCard");
}

function parseContext(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Preflight context must be a JSON object.");
  }

  return value as Record<string, unknown>;
}

async function readPreflightRequest(
  request: IncomingMessage,
  searchParams: URLSearchParams,
): Promise<AgentPublicationPreflightRequest> {
  const body = (await readRequestBody(request)).trim();
  const parsed =
    body === "" ? {} : parseJsonObject(body, "Request body must be a JSON object.");
  const includeRawCard = parseIncludeRawCard(searchParams);

  if (
    parsed.includeRawCard !== undefined &&
    typeof parsed.includeRawCard !== "boolean"
  ) {
    throw new Error("includeRawCard must be a boolean when provided.");
  }

  return {
    context: parseContext(parsed.context ?? parsed.contextValues),
    includeRawCard: includeRawCard || parsed.includeRawCard === true,
  };
}

export function matchAgentPublicationPreflightRoute(
  pathname: string,
): AgentPublicationPreflightRouteMatch | null {
  const match =
    /^\/tenants\/([^/]+)\/agents\/([^/]+)\/environments\/([^/:]+):preflight\/?$/.exec(pathname);

  if (match === null) {
    return null;
  }

  return {
    agentId: decodeURIComponent(match[2]),
    environmentKey: decodeURIComponent(match[3]),
    tenantId: decodeURIComponent(match[1]),
  };
}

export async function handleAgentPublicationPreflightRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: AgentPublicationPreflightRouteMatch,
  dependencies: AgentPublicationPreflightHttpDependencies,
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

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const preflightRequest = await readPreflightRequest(request, url.searchParams);
    writeJson(
      response,
      200,
      await dependencies.service.preflightPublication(
        principal,
        route.tenantId,
        route.agentId,
        route.environmentKey,
        preflightRequest,
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

    if (error instanceof AgentPublicationPreflightAuthorizationError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof AgentEnvironmentPublicationNotFoundError) {
      writeError(response, 404, "publication_not_found", error.message);
      return;
    }

    if (error instanceof Error) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
