import { hasAnyRole, type ResolvedPrincipal } from "@agent-registry/auth";
import type {
  UpsertPublicationTelemetryRequest,
  UpsertPublicationTelemetryResponse,
} from "@agent-registry/contracts";
import type { PublicationTelemetryRepository } from "@agent-registry/db";

export class PublicationTelemetryAuthorizationError extends Error {}

export class PublicationTelemetryValidationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new PublicationTelemetryAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function assertTelemetryWriteAccess(principal: ResolvedPrincipal): void {
  if (!hasAnyRole(principal.roles, ["publisher", "tenant-admin"])) {
    throw new PublicationTelemetryAuthorizationError(
      "Publisher or tenant admin role is required to submit telemetry.",
    );
  }
}

function assertNonNegativeInteger(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new PublicationTelemetryValidationError(
      `${fieldName} must be a non-negative integer.`,
    );
  }

  return value;
}

function assertNullableNonNegativeInteger(value: unknown, fieldName: string): number | null {
  if (value === null) {
    return null;
  }

  return assertNonNegativeInteger(value, fieldName);
}

function assertIsoTimestamp(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new PublicationTelemetryValidationError(
      `${fieldName} must be a valid ISO-8601 timestamp.`,
    );
  }

  return value;
}

function validateTelemetryRequest(
  request: UpsertPublicationTelemetryRequest,
): UpsertPublicationTelemetryRequest {
  const windowStartedAt = assertIsoTimestamp(request.windowStartedAt, "windowStartedAt");
  const windowEndedAt = assertIsoTimestamp(request.windowEndedAt, "windowEndedAt");

  if (Date.parse(windowEndedAt) <= Date.parse(windowStartedAt)) {
    throw new PublicationTelemetryValidationError(
      "windowEndedAt must be later than windowStartedAt.",
    );
  }

  return {
    errorCount: assertNonNegativeInteger(request.errorCount, "errorCount"),
    invocationCount: assertNonNegativeInteger(request.invocationCount, "invocationCount"),
    p50LatencyMs: assertNullableNonNegativeInteger(request.p50LatencyMs, "p50LatencyMs"),
    p95LatencyMs: assertNullableNonNegativeInteger(request.p95LatencyMs, "p95LatencyMs"),
    successCount: assertNonNegativeInteger(request.successCount, "successCount"),
    windowEndedAt,
    windowStartedAt,
  };
}

export class PublicationTelemetryService {
  private readonly repository: PublicationTelemetryRepository;

  constructor(repository: PublicationTelemetryRepository) {
    this.repository = repository;
  }

  async upsertTelemetry(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    versionId: string,
    environmentKey: string,
    request: UpsertPublicationTelemetryRequest,
  ): Promise<UpsertPublicationTelemetryResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTelemetryWriteAccess(principal);

    const validatedRequest = validateTelemetryRequest(request);

    return {
      telemetry: await this.repository.upsertPublicationTelemetry({
        agentId,
        environmentKey,
        errorCount: validatedRequest.errorCount,
        invocationCount: validatedRequest.invocationCount,
        p50LatencyMs: validatedRequest.p50LatencyMs,
        p95LatencyMs: validatedRequest.p95LatencyMs,
        successCount: validatedRequest.successCount,
        tenantId,
        versionId,
        windowEndedAt: validatedRequest.windowEndedAt,
        windowStartedAt: validatedRequest.windowStartedAt,
      }),
    };
  }
}
