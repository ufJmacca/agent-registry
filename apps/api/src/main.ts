import { loadRegistryConfig, type RegistryConfig } from "@agent-registry/config";
import {
  KyselyBootstrapRepository,
  createKyselyDb,
  destroyKyselyDb,
  type AgentRegistryDb,
} from "@agent-registry/db";
import type { PrincipalResolver } from "@agent-registry/auth";

import { createPrincipalResolver } from "./auth/index.js";
import {
  bootstrapFromConfig,
  type BootstrapSummary,
} from "./bootstrap/index.js";

export interface ApiRuntime {
  bootstrapSummary: BootstrapSummary | null;
  close(): Promise<void>;
  config: RegistryConfig;
  db: AgentRegistryDb;
  principalResolver: PrincipalResolver;
}

export async function initializeApiRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApiRuntime> {
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
    principalResolver: createPrincipalResolver(db),
  };
}
