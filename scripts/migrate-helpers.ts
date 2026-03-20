import type { AgentRegistryDb } from "@agent-registry/db";
import { sql } from "kysely";

export async function normalizeLegacyTelemetryMigrationRows(
  db: AgentRegistryDb,
): Promise<void> {
  await sql`
    do $$
    begin
      if to_regclass('public.kysely_migration') is not null then
        delete from kysely_migration
        where name = '005_publication_telemetry_unique_windows'
          and not exists (
            select 1
            from kysely_migration
            where name = '007_publication_telemetry_unique_windows'
          );
      end if;
    end
    $$;
  `.execute(db);
}
