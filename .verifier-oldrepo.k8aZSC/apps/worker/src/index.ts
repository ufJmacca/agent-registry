import { buildDatabaseUrl, defaultDatabaseConfig } from "@agent-registry/db";
import type { ServiceManifest } from "@agent-registry/contracts";

export const workerService: ServiceManifest = {
  name: "worker",
  port: 4100,
  summary: `Background worker placeholder with database ${buildDatabaseUrl(defaultDatabaseConfig)}.`,
};
