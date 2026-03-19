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

function ipv4OctetsToNumber(octets: number[]): number {
  return (
    ((octets[0] << 24) >>> 0) +
    (octets[1] << 16) +
    (octets[2] << 8) +
    octets[3]
  ) >>> 0;
}

function isIpv4InCidr(octets: number[], baseOctets: number[], prefixLength: number): boolean {
  const mask =
    prefixLength === 0 ? 0 : ((0xffff_ffff << (32 - prefixLength)) >>> 0);

  return (
    (ipv4OctetsToNumber(octets) & mask) ===
    (ipv4OctetsToNumber(baseOctets) & mask)
  );
}

function isDisallowedIpv4Octets(octets: number[]): boolean {
  const disallowedRanges: Array<[number[], number]> = [
    [[0, 0, 0, 0], 8],
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10],
    [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12],
    [[192, 168, 0, 0], 16],
    [[198, 18, 0, 0], 15],
    [[224, 0, 0, 0], 4],
    [[240, 0, 0, 0], 4],
  ];

  return disallowedRanges.some(([baseOctets, prefixLength]) =>
    isIpv4InCidr(octets, baseOctets, prefixLength),
  );
}

function parseIpv6Hextets(hostname: string): number[] | null {
  if (isIP(hostname) !== 6) {
    return null;
  }

  let normalizedHostname = hostname;

  if (normalizedHostname.includes(".")) {
    const lastColonIndex = normalizedHostname.lastIndexOf(":");
    const mappedIpv4Octets = parseIpv4Octets(normalizedHostname.slice(lastColonIndex + 1));

    if (mappedIpv4Octets === null) {
      return null;
    }

    const mappedHigh = ((mappedIpv4Octets[0] << 8) | mappedIpv4Octets[1]).toString(16);
    const mappedLow = ((mappedIpv4Octets[2] << 8) | mappedIpv4Octets[3]).toString(16);

    normalizedHostname = `${normalizedHostname.slice(0, lastColonIndex)}:${mappedHigh}:${mappedLow}`;
  }

  const compressedParts = normalizedHostname.split("::");

  if (compressedParts.length > 2) {
    return null;
  }

  const leftParts = compressedParts[0] === "" ? [] : compressedParts[0].split(":");
  const rightParts =
    compressedParts.length === 2 && compressedParts[1] !== ""
      ? compressedParts[1].split(":")
      : [];

  if (leftParts.length + rightParts.length > 8) {
    return null;
  }

  const parts =
    compressedParts.length === 2
      ? [
          ...leftParts,
          ...Array.from({ length: 8 - (leftParts.length + rightParts.length) }, () => "0"),
          ...rightParts,
        ]
      : leftParts;

  if (parts.length !== 8) {
    return null;
  }

  const hextets: number[] = [];

  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }

    hextets.push(Number.parseInt(part, 16));
  }

  return hextets;
}

function extractMappedIpv4OctetsFromIpv6(hextets: number[]): number[] | null {
  if (
    hextets.length !== 8 ||
    hextets[0] !== 0 ||
    hextets[1] !== 0 ||
    hextets[2] !== 0 ||
    hextets[3] !== 0 ||
    hextets[4] !== 0 ||
    hextets[5] !== 0xffff
  ) {
    return null;
  }

  return [
    hextets[6] >> 8,
    hextets[6] & 0xff,
    hextets[7] >> 8,
    hextets[7] & 0xff,
  ];
}

function isDisallowedIpv6Hextets(hextets: number[]): boolean {
  const isAllZero = hextets.every((hextet) => hextet === 0);
  const isLoopback = hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1;
  const firstHextet = hextets[0];

  return (
    isAllZero ||
    isLoopback ||
    (firstHextet & 0xfe00) === 0xfc00 ||
    (firstHextet & 0xffc0) === 0xfe80 ||
    (firstHextet & 0xff00) === 0xff00
  );
}

function isDisallowedProbeTarget(target: string): boolean {
  const normalizedHostname = normalizeProbeHost(target);

  if (normalizedHostname === "localhost") {
    return true;
  }

  const ipv4Octets = parseIpv4Octets(normalizedHostname);

  if (ipv4Octets !== null) {
    return isDisallowedIpv4Octets(ipv4Octets);
  }

  const ipv6Hextets = parseIpv6Hextets(normalizedHostname);

  if (ipv6Hextets !== null) {
    const mappedIpv4Octets = extractMappedIpv4OctetsFromIpv6(ipv6Hextets);

    if (mappedIpv4Octets !== null) {
      return isDisallowedIpv4Octets(mappedIpv4Octets);
    }

    return isDisallowedIpv6Hextets(ipv6Hextets);
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

function buildUnresolvableProbeTargetMessage(options: {
  allowPrivateTargets: boolean;
  deploymentMode: "hosted" | "self-hosted";
}): string {
  if (options.deploymentMode === "hosted") {
    return "Hosted deployments require resolvable health endpoint hostnames.";
  }

  if (!options.allowPrivateTargets) {
    return "Probe policy requires resolvable health endpoint hostnames.";
  }

  return "Health endpoint hostnames must be resolvable.";
}

async function assertProbeTargetAllowed(
  endpointUrl: string,
  options: {
    allowPrivateTargets: boolean;
    deploymentMode: "hosted" | "self-hosted";
    resolveProbeHostname: ProbeHostnameResolver;
  },
): Promise<void> {
  const hostname = new URL(endpointUrl).hostname;
  const resolvedTargets = await resolveProbeTargets(hostname, options.resolveProbeHostname);

  if (resolvedTargets.length === 0) {
    throw new AgentVersionProbeTargetPolicyError(buildUnresolvableProbeTargetMessage(options));
  }

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
