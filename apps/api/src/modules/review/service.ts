import { hasAnyRole, type ResolvedPrincipal } from "@agent-registry/auth";
import {
  assertHealthProbeTargetAllowed,
  HealthProbeTargetPolicyError,
  type ProbeHostnameResolver,
} from "@agent-registry/config";
import type { VersionLifecycleResponse } from "@agent-registry/contracts";
import {
  type AgentReviewRepository,
  InvalidVersionTransitionError,
} from "@agent-registry/db";

export interface AgentVersionReviewServiceOptions {
  allowPrivateTargets?: boolean;
  deploymentMode?: "hosted" | "self-hosted";
  requireHttps?: boolean;
  resolveProbeHostname?: ProbeHostnameResolver;
}

export class AgentVersionReviewAuthorizationError extends Error {}

export class AgentVersionReviewValidationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new AgentVersionReviewAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function assertPublisherAccess(principal: ResolvedPrincipal): void {
  if (!hasAnyRole(principal.roles, ["publisher", "tenant-admin"])) {
    throw new AgentVersionReviewAuthorizationError(
      "Publisher role is required to submit agent versions for review.",
    );
  }
}

function assertTenantAdminAccess(principal: ResolvedPrincipal): void {
  if (!hasAnyRole(principal.roles, ["tenant-admin"])) {
    throw new AgentVersionReviewAuthorizationError(
      "Tenant admin role is required to review agent versions.",
    );
  }
}

function assertRejectReason(value: string): string {
  if (value.trim() === "") {
    throw new AgentVersionReviewValidationError("Reject reason must be a non-empty string.");
  }

  return value.trim();
}

export class AgentVersionReviewService {
  private readonly allowPrivateTargets: boolean;

  private readonly deploymentMode: "hosted" | "self-hosted";

  private readonly requireHttps: boolean;

  private readonly resolveProbeHostname: ProbeHostnameResolver | undefined;

  private readonly repository: AgentReviewRepository;

  constructor(
    repository: AgentReviewRepository,
    options: AgentVersionReviewServiceOptions = {},
  ) {
    this.allowPrivateTargets = options.allowPrivateTargets ?? false;
    this.deploymentMode = options.deploymentMode ?? "hosted";
    this.requireHttps = options.requireHttps ?? this.deploymentMode === "hosted";
    this.resolveProbeHostname = options.resolveProbeHostname;
    this.repository = repository;
  }

  async submitVersion(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    versionId: string,
  ): Promise<VersionLifecycleResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertPublisherAccess(principal);

    return this.repository.submitVersion({
      agentId,
      submittedBy: principal.subjectId,
      tenantId,
      versionId,
    });
  }

  async approveVersion(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    versionId: string,
  ): Promise<VersionLifecycleResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    const version = await this.repository.getVersionForReview(tenantId, agentId, versionId);

    if (version.approvalState === "pending_review") {
      await Promise.all(
        version.publications.map((publication) =>
          assertHealthProbeTargetAllowed(publication.healthEndpointUrl, {
            allowPrivateTargets: this.allowPrivateTargets,
            deploymentMode: this.deploymentMode,
            requireHttps: this.requireHttps,
            resolveProbeHostname: this.resolveProbeHostname,
          }),
        ),
      );
    }

    return this.repository.approveVersion({
      agentId,
      approvedBy: principal.subjectId,
      tenantId,
      versionId,
    });
  }

  async rejectVersion(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    versionId: string,
    reason: string,
  ): Promise<VersionLifecycleResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    return this.repository.rejectVersion({
      agentId,
      rejectedBy: principal.subjectId,
      rejectedReason: assertRejectReason(reason),
      tenantId,
      versionId,
    });
  }
}

export { InvalidVersionTransitionError };
export { HealthProbeTargetPolicyError as AgentVersionProbeTargetPolicyError };
