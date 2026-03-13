import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  type PrincipalResolver,
} from "@agent-registry/auth";
import type { RejectAgentVersionRequest } from "@agent-registry/contracts";
import {
  AgentVersionNotFoundError,
  InvalidVersionTransitionError,
} from "@agent-registry/db";

import {
  AgentVersionProbeTargetPolicyError,
  AgentVersionReviewAuthorizationError,
  AgentVersionReviewService,
  AgentVersionReviewValidationError,
} from "./service.js";

type ReviewAction = "approve" | "reject" | "submit";

export interface AgentVersionReviewRouteMatch {
  action: ReviewAction;
  agentId: string;
  tenantId: string;
  versionId: string;
}

export interface AgentVersionReviewHttpDependencies {
  principalResolver: PrincipalResolver;
  service: AgentVersionReviewService;
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

async function readRejectRequest(request: IncomingMessage): Promise<RejectAgentVersionRequest> {
  const body = (await readRequestBody(request)).trim();

  if (body === "") {
    throw new Error("Request body must be a JSON object with a reason string.");
  }

  const parsed = parseJsonObject(body, "Request body must be a JSON object.");

  if (typeof parsed.reason !== "string") {
    throw new Error("Request body must be a JSON object with a reason string.");
  }

  return {
    reason: parsed.reason,
  };
}

export function matchAgentVersionReviewRoute(
  pathname: string,
): AgentVersionReviewRouteMatch | null {
  const match =
    /^\/tenants\/([^/]+)\/agents\/([^/]+)\/versions\/([^/:]+):(submit|approve|reject)\/?$/.exec(
      pathname,
    );

  if (match === null) {
    return null;
  }

  return {
    action: match[4] as ReviewAction,
    agentId: decodeURIComponent(match[2]),
    tenantId: decodeURIComponent(match[1]),
    versionId: decodeURIComponent(match[3]),
  };
}

export async function handleAgentVersionReviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: AgentVersionReviewRouteMatch,
  dependencies: AgentVersionReviewHttpDependencies,
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

    if (route.action === "submit") {
      writeJson(
        response,
        200,
        await dependencies.service.submitVersion(
          principal,
          route.tenantId,
          route.agentId,
          route.versionId,
        ),
      );
      return;
    }

    if (route.action === "approve") {
      writeJson(
        response,
        200,
        await dependencies.service.approveVersion(
          principal,
          route.tenantId,
          route.agentId,
          route.versionId,
        ),
      );
      return;
    }

    const rejectRequest = await readRejectRequest(request);
    writeJson(
      response,
      200,
      await dependencies.service.rejectVersion(
        principal,
        route.tenantId,
        route.agentId,
        route.versionId,
        rejectRequest.reason,
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

    if (error instanceof AgentVersionReviewAuthorizationError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof AgentVersionNotFoundError) {
      writeError(response, 404, "version_not_found", error.message);
      return;
    }

    if (error instanceof InvalidVersionTransitionError) {
      writeError(response, 409, "invalid_lifecycle_transition", error.message);
      return;
    }

    if (error instanceof AgentVersionProbeTargetPolicyError) {
      writeError(response, 400, "invalid_probe_target", error.message);
      return;
    }

    if (error instanceof AgentVersionReviewValidationError) {
      writeError(response, 400, "invalid_review_request", error.message);
      return;
    }

    if (error instanceof Error) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
