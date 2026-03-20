import http from "node:http";

import { PgBoss } from "pg-boss";

import { createWebRequestListener } from "./http.js";
import { webService } from "./index.js";
import { initializeWebRuntime } from "./main.js";

const HEALTH_PROBE_JOB_NAME = "publication-health-probe";

const port = webService.port;
let shuttingDown = false;

async function main(): Promise<void> {
  const runtime = await initializeWebRuntime();
  const boss = new PgBoss(runtime.config.databaseUrl);
  let server: http.Server | undefined;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`web console shutting down after ${signal}`);
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
    await boss.stop();
    await runtime.close();
  }

  boss.on("error", (error) => {
    console.error("pg-boss error", error);
  });

  try {
    await boss.start();
    await boss.createQueue(HEALTH_PROBE_JOB_NAME);

    server = http.createServer(
      createWebRequestListener({
        config: runtime.config,
        db: runtime.db,
        reviewServiceOptions: {
          async enqueuePublicationProbe(publicationId) {
            await boss.send(
              HEALTH_PROBE_JOB_NAME,
              { publicationId },
              {
                singletonKey: publicationId,
                singletonSeconds: runtime.config.healthProbe.intervalSeconds,
              },
            );
          },
        },
      }),
    );

    server.listen(port, () => {
      console.log(`web console listening on http://0.0.0.0:${port}`);
    });

    process.on("SIGINT", () => {
      void shutdown("SIGINT");
    });

    process.on("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  } catch (error) {
    await boss.stop().catch(() => undefined);
    await runtime.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
