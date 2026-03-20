import {
  assertHealthProbeTargetAllowed,
  type HealthProbeConfig,
  type ProbeHostnameResolver,
  type PublicationProbeCheck,
} from "@agent-registry/config";
import type { HealthRepository } from "@agent-registry/db";

export const HEALTH_PROBE_JOB_NAME = "publication-health-probe";
export const HEALTH_PROBE_RECONCILE_JOB_NAME = "publication-health-probe-reconcile";
export const HEALTH_PROBE_RECONCILE_CRON = "* * * * *";

interface ProbeJobPayload {
  publicationId: string;
}

interface BossJob<TData> {
  data: TData;
}

interface ProbeEndpointOptions {
  fetchImpl?: typeof fetch;
  timeoutSeconds: number;
}

interface HealthProbeWorkerOptions {
  deploymentMode?: "hosted" | "self-hosted";
  fetchImpl?: typeof fetch;
  resolveProbeHostname?: ProbeHostnameResolver;
}

export interface HealthProbeBoss {
  createQueue?(name: string): Promise<unknown>;
  schedule(name: string, cron: string, data?: Record<string, unknown>): Promise<unknown>;
  send(name: string, data?: Record<string, unknown>): Promise<unknown>;
  work(
    name: string,
    handler: (jobs?: Array<BossJob<Record<string, unknown>>> | Record<string, unknown>) => Promise<void>,
  ): Promise<unknown> | unknown;
}

function extractPayloads<TData extends Record<string, unknown>>(
  jobs?: Array<BossJob<TData>> | TData,
): TData[] {
  if (jobs === undefined) {
    return [];
  }

  if (Array.isArray(jobs)) {
    return jobs.map((job) => job.data);
  }

  return [jobs];
}

function formatProbeFailure(statusCode: number): string {
  return `received ${statusCode} from health endpoint`;
}

function buildProbeReconcileCron(intervalSeconds: number): string {
  if (intervalSeconds < 60 || intervalSeconds % 60 !== 0) {
    throw new Error(
      "HEALTH_PROBE_INTERVAL_SECONDS must be a whole number of minutes for pg-boss scheduling.",
    );
  }

  const intervalMinutes = intervalSeconds / 60;

  if (intervalMinutes === 1) {
    return HEALTH_PROBE_RECONCILE_CRON;
  }

  if (intervalMinutes < 60 && 60 % intervalMinutes === 0) {
    return `*/${intervalMinutes} * * * *`;
  }

  if (intervalMinutes === 60) {
    return "0 * * * *";
  }

  if (intervalMinutes % 60 === 0) {
    const intervalHours = intervalMinutes / 60;

    if (intervalHours < 24 && 24 % intervalHours === 0) {
      return `0 */${intervalHours} * * *`;
    }

    if (intervalHours === 24) {
      return "0 0 * * *";
    }
  }

  throw new Error(
    "HEALTH_PROBE_INTERVAL_SECONDS must align to a pg-boss cron interval (1m, divisors of 1h, divisors of 1d, or 24h).",
  );
}

export async function probeHealthEndpoint(
  endpointUrl: string,
  options: ProbeEndpointOptions,
): Promise<PublicationProbeCheck> {
  const checkedAt = new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  try {
    const response = await fetchImpl(endpointUrl, {
      credentials: "omit",
      headers: new Headers(),
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
    });

    if (response.ok) {
      return {
        checkedAt,
        error: null,
        ok: true,
        statusCode: response.status,
      };
    }

    return {
      checkedAt,
      error: formatProbeFailure(response.status),
      ok: false,
      statusCode: response.status,
    };
  } catch (error) {
    return {
      checkedAt,
      error: error instanceof Error ? error.message : "Health probe failed.",
      ok: false,
      statusCode: null,
    };
  }
}

export class HealthProbeWorker {
  private readonly boss: HealthProbeBoss;

  private readonly config: HealthProbeConfig;

  private readonly deploymentMode: "hosted" | "self-hosted";

  private readonly fetchImpl: typeof fetch | undefined;

  private readonly repository: HealthRepository;

  private readonly resolveProbeHostname: ProbeHostnameResolver | undefined;

  constructor(
    config: HealthProbeConfig,
    boss: HealthProbeBoss,
    repository: HealthRepository,
    options: HealthProbeWorkerOptions = {},
  ) {
    this.boss = boss;
    this.config = config;
    this.deploymentMode = options.deploymentMode ?? "hosted";
    this.fetchImpl = options.fetchImpl;
    this.repository = repository;
    this.resolveProbeHostname = options.resolveProbeHostname;
  }

  async start(): Promise<void> {
    if (typeof this.boss.createQueue === "function") {
      await this.boss.createQueue(HEALTH_PROBE_JOB_NAME);
      await this.boss.createQueue(HEALTH_PROBE_RECONCILE_JOB_NAME);
    }

    await Promise.resolve(
      this.boss.work(HEALTH_PROBE_JOB_NAME, async (jobs) => this.handleProbeJobs(jobs)),
    );
    await Promise.resolve(
      this.boss.work(HEALTH_PROBE_RECONCILE_JOB_NAME, async () => this.reconcileApprovedPublications()),
    );
    await this.boss.schedule(
      HEALTH_PROBE_RECONCILE_JOB_NAME,
      buildProbeReconcileCron(this.config.intervalSeconds),
    );
    await this.reconcileApprovedPublications();
  }

  private async handleProbeJobs(
    jobs?: Array<BossJob<Record<string, unknown>>> | Record<string, unknown>,
  ): Promise<void> {
    for (const payload of extractPayloads(jobs)) {
      if (typeof payload.publicationId !== "string" || payload.publicationId.trim() === "") {
        continue;
      }

      await this.probePublication(payload.publicationId);
    }
  }

  private async probePublication(publicationId: string): Promise<void> {
    const publication = await this.repository.getApprovedPublicationForProbing(publicationId);

    if (publication === null) {
      return;
    }

    try {
      await assertHealthProbeTargetAllowed(publication.healthEndpointUrl, {
        allowPrivateTargets: this.config.allowPrivateTargets,
        deploymentMode: this.deploymentMode,
        requireHttps: this.config.requireHttps,
        resolveProbeHostname: this.resolveProbeHostname,
      });

      const result = await probeHealthEndpoint(publication.healthEndpointUrl, {
        fetchImpl: this.fetchImpl,
        timeoutSeconds: this.config.timeoutSeconds,
      });

      await this.repository.recordPublicationProbe({
        ...result,
        degradedThreshold: this.config.degradedThreshold,
        failureWindow: this.config.failureWindow,
        publicationId,
      });
    } catch (error) {
      await this.repository.recordPublicationProbe({
        checkedAt: new Date().toISOString(),
        degradedThreshold: this.config.degradedThreshold,
        error: error instanceof Error ? error.message : "Health probe failed.",
        failureWindow: this.config.failureWindow,
        ok: false,
        publicationId,
        statusCode: null,
      });
    }
  }

  private async reconcileApprovedPublications(): Promise<void> {
    const publications = await this.repository.listApprovedPublicationsForProbing();

    for (const publication of publications) {
      await this.boss.send(HEALTH_PROBE_JOB_NAME, {
        publicationId: publication.publicationId,
      });
    }
  }
}
