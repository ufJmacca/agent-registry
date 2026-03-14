import { loadRegistryConfig, type RegistryConfig } from "@agent-registry/config";
import {
  KyselyBootstrapRepository,
  createKyselyDb,
  destroyKyselyDb,
  type AgentRegistryDb,
} from "@agent-registry/db";

import { bootstrapFromConfig, type BootstrapSummary } from "../../api/src/bootstrap/index.js";

export interface WebRuntime {
  bootstrapSummary: BootstrapSummary | null;
  close(): Promise<void>;
  config: RegistryConfig;
  db: AgentRegistryDb;
}

export async function initializeWebRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WebRuntime> {
  const config = loadRegistryConfig(env);
  const db = createKyselyDb(config.databaseUrl);
  const bootstrapSummary = await bootstrapFromConfig(
    config,
    new KyselyBootstrapRepository(db),
  );

  return {
    bootstrapSummary,
    async close() {
      await destroyKyselyDb(db);
    },
    config,
    db,
  };
}
