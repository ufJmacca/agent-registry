import { loadRegistryConfig } from "@agent-registry/config";
import {
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  normalizeLegacyTelemetryMigrationRows,
} from "@agent-registry/db";

const config = loadRegistryConfig(process.env, {
  requireBootstrapFile: false,
});
const db = createKyselyDb(config.databaseUrl);

try {
  // Normalize legacy telemetry migration rows from earlier slices so the
  // current forward-only migration set can run against the shared compose DB.
  await normalizeLegacyTelemetryMigrationRows(db);

  const results = await migrateToLatest(db);

  console.log(`Migrated ${config.databaseUrl}`);

  for (const result of results) {
    console.log(`${result.migrationName}: ${result.status}`);
  }
} finally {
  await destroyKyselyDb(db);
}
