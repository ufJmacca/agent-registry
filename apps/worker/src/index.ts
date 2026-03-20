import { buildDatabaseUrl, defaultDatabaseConfig } from "@agent-registry/db";
import type { ServiceManifest } from "@agent-registry/contracts";

export * from "./health-probe-worker.js";

export const workerService: ServiceManifest = {
  name: "worker",
  port: 4100,
  summary: `Background worker running health probes with database ${buildDatabaseUrl(defaultDatabaseConfig)}.`,
};
