import type { IncomingMessage, ServerResponse } from "node:http";

import {
  MissingSubjectIdError,
  MissingTenantMembershipError,
  type PrincipalResolver,
} from "@agent-registry/auth";
import type {
  CreateDraftAgentRequest,
  CreateDraftVersionRequest,
} from "@agent-registry/contracts";

import {
  AgentDraftNotFoundError,
  AgentDraftRegistrationAuthorizationError,
  AgentDraftRegistrationService,
  AgentDraftRegistrationValidationError,
} from "./service.js";

type AgentDraftRouteMatch =
  | {
      agentId: string;
      tenantId: string;
      type: "version";
    }
  | {
      tenantId: string;
      type: "agent";
    };

export interface AgentDraftHttpDependencies {
  principalResolver: PrincipalResolver;
  service: AgentDraftRegistrationService;
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

async function readDraftRegistrationRequest(
  request: IncomingMessage,
): Promise<CreateDraftAgentRequest | CreateDraftVersionRequest> {
  const body = (await readRequestBody(request)).trim();

  if (body === "") {
    throw new Error("Request body must be a JSON object.");
  }

  return parseJsonObject(body, "Request body must be a JSON object.") as unknown as
    | CreateDraftAgentRequest
    | CreateDraftVersionRequest;
}

export function matchAgentDraftRoute(pathname: string): AgentDraftRouteMatch | null {
  const createVersionMatch = /^\/tenants\/([^/]+)\/agents\/([^/]+)\/versions\/?$/.exec(pathname);

  if (createVersionMatch !== null) {
    return {
      agentId: decodeURIComponent(createVersionMatch[2]),
      tenantId: decodeURIComponent(createVersionMatch[1]),
      type: "version",
    };
  }

  const createAgentMatch = /^\/tenants\/([^/]+)\/agents\/?$/.exec(pathname);

  if (createAgentMatch !== null) {
    return {
      tenantId: decodeURIComponent(createAgentMatch[1]),
      type: "agent",
    };
  }

  return null;
}

export async function handleAgentDraftRequest(
  request: IncomingMessage,
  response: ServerResponse,
  route: AgentDraftRouteMatch,
  dependencies: AgentDraftHttpDependencies,
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

    const draftRequest = await readDraftRegistrationRequest(request);

    if (route.type === "agent") {
      writeJson(
        response,
        201,
        await dependencies.service.createDraftAgent(
          principal,
          route.tenantId,
          draftRequest as CreateDraftAgentRequest,
        ),
      );
      return;
    }

    writeJson(
      response,
      201,
      await dependencies.service.createDraftVersion(
        principal,
        route.tenantId,
        route.agentId,
        draftRequest as CreateDraftVersionRequest,
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

    if (error instanceof AgentDraftRegistrationAuthorizationError) {
      writeError(response, 403, "forbidden", error.message);
      return;
    }

    if (error instanceof AgentDraftNotFoundError) {
      writeError(response, 404, "agent_not_found", error.message);
      return;
    }

    if (error instanceof AgentDraftRegistrationValidationError) {
      writeError(response, 400, "invalid_registration", error.message);
      return;
    }

    if (error instanceof Error) {
      writeError(response, 400, "invalid_request", error.message);
      return;
    }

    writeError(response, 500, "internal_error", "Internal server error.");
  }
}
