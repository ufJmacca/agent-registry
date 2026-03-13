import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { hasAnyRole, type ResolvedPrincipal } from "@agent-registry/auth";
import type { VersionLifecycleResponse } from "@agent-registry/contracts";
import {
  type AgentReviewRepository,
  InvalidVersionTransitionError,
} from "@agent-registry/db";

export interface AgentVersionReviewServiceOptions {
  allowPrivateTargets?: boolean;
  deploymentMode?: "hosted" | "self-hosted";
  resolveProbeHostname?: ProbeHostnameResolver;
}

type ProbeHostnameResolver = (hostname: string) => Promise<string[]>;

export class AgentVersionReviewAuthorizationError extends Error {}

export class AgentVersionReviewValidationError extends Error {}

export class AgentVersionProbeTargetPolicyError extends Error {}

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

const dnsResolutionFailureCodes = new Set([
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ENOTFOUND",
  "EREFUSED",
  "ESERVFAIL",
  "ETIMEOUT",
]);

function normalizeProbeHost(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

async function defaultResolveProbeHostname(hostname: string): Promise<string[]> {
  const addresses = await lookup(hostname, {
    all: true,
    verbatim: true,
  });

  return addresses.map((address) => address.address);
}

function isDnsResolutionFailure(error: unknown): error is NodeJS.ErrnoException {
  const code =
    error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;

  return (
    error instanceof Error &&
    typeof code === "string" &&
    dnsResolutionFailureCodes.has(code)
  );
}

function parseIpv4Octets(hostname: string): number[] | null {
  if (isIP(hostname) !== 4) {
    return null;
  }

  return hostname.split(".").map((segment) => Number.parseInt(segment, 10));
}

function isDisallowedProbeTarget(target: string): boolean {
  const normalizedHostname = normalizeProbeHost(target);

  if (normalizedHostname === "localhost") {
    return true;
  }

  const ipv4Octets = parseIpv4Octets(normalizedHostname);

  if (ipv4Octets !== null) {
    const [first, second] = ipv4Octets;

    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  const normalizedIpv6 = normalizedHostname.replace(/^\[|\]$/g, "");

  if (isIP(normalizedIpv6) === 6) {
    const mappedIpv4Address = normalizedIpv6.startsWith("::ffff:")
      ? normalizedIpv6.slice("::ffff:".length)
      : null;

    if (mappedIpv4Address !== null && isIP(mappedIpv4Address) === 4) {
      return isDisallowedProbeTarget(mappedIpv4Address);
    }

    return (
      normalizedIpv6 === "::1" ||
      normalizedIpv6.startsWith("fc") ||
      normalizedIpv6.startsWith("fd") ||
      normalizedIpv6.startsWith("fe8") ||
      normalizedIpv6.startsWith("fe9") ||
      normalizedIpv6.startsWith("fea") ||
      normalizedIpv6.startsWith("feb")
    );
  }

  return false;
}

async function resolveProbeTargets(
  hostname: string,
  resolveProbeHostname: ProbeHostnameResolver,
): Promise<string[]> {
  const normalizedHostname = normalizeProbeHost(hostname);

  if (normalizedHostname === "localhost" || isIP(normalizedHostname) !== 0) {
    return [normalizedHostname];
  }

  try {
    const resolvedTargets = await resolveProbeHostname(normalizedHostname);

    return resolvedTargets.map((target) => normalizeProbeHost(target));
  } catch (error) {
    if (isDnsResolutionFailure(error)) {
      return [];
    }

    throw error;
  }
}

async function assertProbeTargetAllowed(
  endpointUrl: string,
  options: {
    allowPrivateTargets: boolean;
    deploymentMode: "hosted" | "self-hosted";
    resolveProbeHostname: ProbeHostnameResolver;
  },
): Promise<void> {
  if (options.deploymentMode === "self-hosted" && options.allowPrivateTargets) {
    return;
  }

  const hostname = new URL(endpointUrl).hostname;
  const resolvedTargets = await resolveProbeTargets(hostname, options.resolveProbeHostname);

  if (!resolvedTargets.some((target) => isDisallowedProbeTarget(target))) {
    return;
  }

  if (options.deploymentMode === "hosted") {
    throw new AgentVersionProbeTargetPolicyError(
      "Hosted deployments cannot probe private or loopback health endpoints.",
    );
  }

  if (!options.allowPrivateTargets) {
    throw new AgentVersionProbeTargetPolicyError(
      "Probe policy does not allow private or loopback health endpoints.",
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

  private readonly resolveProbeHostname: ProbeHostnameResolver;

  private readonly repository: AgentReviewRepository;

  constructor(
    repository: AgentReviewRepository,
    options: AgentVersionReviewServiceOptions = {},
  ) {
    this.allowPrivateTargets = options.allowPrivateTargets ?? false;
    this.deploymentMode = options.deploymentMode ?? "hosted";
    this.resolveProbeHostname = options.resolveProbeHostname ?? defaultResolveProbeHostname;
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
        version.publications.map(async (publication) =>
          assertProbeTargetAllowed(publication.healthEndpointUrl, {
            allowPrivateTargets: this.allowPrivateTargets,
            deploymentMode: this.deploymentMode,
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
