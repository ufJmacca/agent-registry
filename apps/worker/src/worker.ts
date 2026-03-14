import { loadRegistryConfig } from "@agent-registry/config";
import {
  KyselyHealthRepository,
  createKyselyDb,
  destroyKyselyDb,
} from "@agent-registry/db";
import { PgBoss } from "pg-boss";

import { HealthProbeWorker } from "./health-probe-worker.js";

const config = loadRegistryConfig(process.env, { requireBootstrapFile: false });
const db = createKyselyDb(config.databaseUrl);
const boss = new PgBoss(config.databaseUrl);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`worker shutting down after ${signal}`);
  await boss.stop();
  await destroyKyselyDb(db);
}

async function main(): Promise<void> {
  boss.on("error", (error) => {
    console.error("pg-boss error", error);
  });

  await boss.start();

  const worker = new HealthProbeWorker(
    config.healthProbe,
    boss,
    new KyselyHealthRepository(db),
    {
      deploymentMode: config.deploymentMode,
    },
  );

  await worker.start();
  console.log("health probe worker started");

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch(async (error) => {
  console.error(error);
  await shutdown("startup failure");
  process.exitCode = 1;
});
