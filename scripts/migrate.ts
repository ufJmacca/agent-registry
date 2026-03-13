import { loadRegistryConfig } from "@agent-registry/config";
import {
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
} from "@agent-registry/db";

const config = loadRegistryConfig(process.env, {
  requireBootstrapFile: false,
});
const db = createKyselyDb(config.databaseUrl);

try {
  const results = await migrateToLatest(db);

  console.log(`Migrated ${config.databaseUrl}`);

  for (const result of results) {
    console.log(`${result.migrationName}: ${result.status}`);
  }
} finally {
  await destroyKyselyDb(db);
}
