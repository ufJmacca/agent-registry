import type {
  DiscoveryHealthStatus,
  DiscoveryPublicationStatus,
} from "@agent-registry/contracts";

import { AgentDiscoveryValidationError } from "./service.js";

const supportedStatuses: DiscoveryPublicationStatus[] = [
  "approved_active",
  "approved_inactive",
  "draft",
  "pending_review",
  "rejected",
];
const supportedHealthStatuses: DiscoveryHealthStatus[] = [
  "unknown",
  "healthy",
  "degraded",
  "unreachable",
];

export interface DiscoveryListQuery {
  deprecated: boolean | null;
  environmentKeys: string[];
  healthStatuses: DiscoveryHealthStatus[];
  includeRawCard: boolean;
  page: number;
  pageSize: number;
  publisherIds: string[];
  q: string | null;
  requiredContextKeys: string[];
  requiredHeaders: string[];
  requiredScopes: string[];
  statuses: DiscoveryPublicationStatus[];
}

function parseBoolean(value: string, fieldName: string): boolean {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new AgentDiscoveryValidationError(`${fieldName} must be 'true' or 'false'.`);
}

function parsePositiveInteger(
  value: string | null,
  fieldName: string,
  defaultValue: number,
): number {
  if (value === null) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AgentDiscoveryValidationError(`${fieldName} must be a positive integer.`);
  }

  return parsed;
}

function parseOptionalString(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function parseRepeatedStrings(
  searchParams: URLSearchParams,
  fieldName: string,
): string[] {
  const values = searchParams
    .getAll(fieldName)
    .map((value) => value.trim())
    .filter((value) => value !== "");

  return [...new Set(values)];
}

function parseSingleBoolean(
  searchParams: URLSearchParams,
  fieldName: string,
): boolean | null {
  const values = searchParams.getAll(fieldName);

  if (values.length === 0) {
    return null;
  }

  if (values.length > 1) {
    throw new AgentDiscoveryValidationError(`${fieldName} may only be specified once.`);
  }

  return parseBoolean(values[0], fieldName);
}

function parseStatuses(searchParams: URLSearchParams): DiscoveryPublicationStatus[] {
  const requestedStatuses = parseRepeatedStrings(searchParams, "status");

  for (const status of requestedStatuses) {
    if (!supportedStatuses.includes(status as DiscoveryPublicationStatus)) {
      throw new AgentDiscoveryValidationError(`Unsupported status filter '${status}'.`);
    }
  }

  return requestedStatuses as DiscoveryPublicationStatus[];
}

function parseHealthStatuses(searchParams: URLSearchParams): DiscoveryHealthStatus[] {
  const requestedHealthStatuses = parseRepeatedStrings(searchParams, "healthStatus");

  for (const status of requestedHealthStatuses) {
    if (!supportedHealthStatuses.includes(status as DiscoveryHealthStatus)) {
      throw new AgentDiscoveryValidationError(`Unsupported healthStatus filter '${status}'.`);
    }
  }

  return requestedHealthStatuses as DiscoveryHealthStatus[];
}

function parseIncludeRawCard(searchParams: URLSearchParams): boolean {
  const includes = parseRepeatedStrings(searchParams, "include");

  for (const include of includes) {
    if (include !== "rawCard") {
      throw new AgentDiscoveryValidationError(`Unsupported include value '${include}'.`);
    }
  }

  return includes.includes("rawCard");
}

export function parseDiscoveryListQuery(
  searchParams: URLSearchParams,
  options: {
    allowTextQuery: boolean;
  },
): DiscoveryListQuery {
  const includeRawCard = parseIncludeRawCard(searchParams);
  const statuses = parseStatuses(searchParams);

  if (includeRawCard && statuses.some((status) => status !== "approved_active")) {
    throw new AgentDiscoveryValidationError(
      "include=rawCard is only supported for approved_active result sets.",
    );
  }

  const q = parseOptionalString(searchParams.get("q"));

  if (!options.allowTextQuery && q !== null) {
    throw new AgentDiscoveryValidationError("The q parameter is only supported on search.");
  }

  return {
    deprecated: parseSingleBoolean(searchParams, "deprecated"),
    environmentKeys: parseRepeatedStrings(searchParams, "environment"),
    healthStatuses: parseHealthStatuses(searchParams),
    includeRawCard,
    page: parsePositiveInteger(searchParams.get("page"), "page", 1),
    pageSize: parsePositiveInteger(searchParams.get("pageSize"), "pageSize", 20),
    publisherIds: parseRepeatedStrings(searchParams, "publisher"),
    q,
    requiredContextKeys: parseRepeatedStrings(searchParams, "requiredContextKey"),
    requiredHeaders: parseRepeatedStrings(searchParams, "requiredHeader"),
    requiredScopes: parseRepeatedStrings(searchParams, "requiredScope"),
    statuses,
  };
}
