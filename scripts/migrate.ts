import { loadRegistryConfig } from "@agent-registry/config";
import {
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
} from "@agent-registry/db";
import { sql } from "kysely";

const config = loadRegistryConfig(process.env, {
  requireBootstrapFile: false,
});
const db = createKyselyDb(config.databaseUrl);

try {
  const migrationTableResult = await sql<{ exists: boolean }>`
    select to_regclass('public.kysely_migration') is not null as exists
  `.execute(db);

  if (migrationTableResult.rows[0]?.exists ?? false) {
    // Normalize legacy telemetry migration rows from earlier slices so the
    // current forward-only migration set can run against the shared compose DB.
    await sql`
      delete from kysely_migration
      where name = '005_publication_telemetry_unique_windows'
        and not exists (
          select 1
          from kysely_migration
          where name = '007_publication_telemetry_unique_windows'
        )
    `.execute(db);
  }

  const results = await migrateToLatest(db);

  console.log(`Migrated ${config.databaseUrl}`);

  for (const result of results) {
    console.log(`${result.migrationName}: ${result.status}`);
  }
} finally {
  await destroyKyselyDb(db);
}
