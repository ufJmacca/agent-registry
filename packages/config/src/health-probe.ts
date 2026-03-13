import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { HealthStatus } from "@agent-registry/contracts";

const dnsResolutionFailureCodes = new Set([
  "EAI_AGAIN",
  "EAI_FAIL",
  "ENODATA",
  "ENOTFOUND",
  "EREFUSED",
  "ESERVFAIL",
  "ETIMEOUT",
]);

export type ProbeHostnameResolver = (hostname: string) => Promise<string[]>;

export interface ProbeTargetPolicyOptions {
  allowPrivateTargets: boolean;
  deploymentMode: "hosted" | "self-hosted";
  requireHttps?: boolean;
  resolveProbeHostname?: ProbeHostnameResolver;
}

export interface PublicationProbeCheck {
  checkedAt: string;
  error: string | null;
  ok: boolean;
  statusCode: number | null;
}

export interface ReducedPublicationHealth {
  consecutiveFailures: number;
  healthStatus: HealthStatus;
  recentFailures: number;
}

export class HealthProbeTargetPolicyError extends Error {}

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

  return error instanceof Error && typeof code === "string" && dnsResolutionFailureCodes.has(code);
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

export async function assertHealthProbeTargetAllowed(
  endpointUrl: string,
  options: ProbeTargetPolicyOptions,
): Promise<void> {
  const parsedEndpoint = new URL(endpointUrl);

  if (options.requireHttps && parsedEndpoint.protocol !== "https:") {
    if (options.deploymentMode === "hosted") {
      throw new HealthProbeTargetPolicyError(
        `Hosted deployments require HTTPS health endpoints; received '${endpointUrl}'.`,
      );
    }

    throw new HealthProbeTargetPolicyError(
      `Health probe policy requires HTTPS health endpoints; received '${endpointUrl}'.`,
    );
  }

  if (options.deploymentMode === "self-hosted" && options.allowPrivateTargets) {
    return;
  }

  const resolveProbeHostname = options.resolveProbeHostname ?? defaultResolveProbeHostname;
  const hostname = parsedEndpoint.hostname;
  const resolvedTargets = await resolveProbeTargets(hostname, resolveProbeHostname);

  if (!resolvedTargets.some((target) => isDisallowedProbeTarget(target))) {
    return;
  }

  if (options.deploymentMode === "hosted") {
    throw new HealthProbeTargetPolicyError(
      "Hosted deployments cannot probe private or loopback health endpoints.",
    );
  }

  throw new HealthProbeTargetPolicyError(
    "Probe policy does not allow private or loopback health endpoints.",
  );
}

export function reducePublicationHealth(
  checks: readonly PublicationProbeCheck[],
  options: {
    degradedThreshold?: number;
    failureWindow?: number;
  } = {},
): ReducedPublicationHealth {
  const degradedThreshold = options.degradedThreshold ?? 1;
  const failureWindow = options.failureWindow ?? 3;
  const recentChecks = [...checks]
    .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))
    .slice(0, failureWindow);

  if (recentChecks.length === 0) {
    return {
      consecutiveFailures: 0,
      healthStatus: "unknown",
      recentFailures: 0,
    };
  }

  const recentFailures = recentChecks.filter((check) => !check.ok).length;
  let consecutiveFailures = 0;

  for (const check of recentChecks) {
    if (check.ok) {
      break;
    }

    consecutiveFailures += 1;
  }

  if (consecutiveFailures >= failureWindow) {
    return {
      consecutiveFailures,
      healthStatus: "unreachable",
      recentFailures,
    };
  }

  if (recentFailures >= degradedThreshold) {
    return {
      consecutiveFailures,
      healthStatus: "degraded",
      recentFailures,
    };
  }

  return {
    consecutiveFailures,
    healthStatus: "healthy",
    recentFailures,
  };
}
