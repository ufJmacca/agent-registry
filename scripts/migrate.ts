import { buildDatabaseUrl, defaultDatabaseConfig } from "@agent-registry/db";

const databaseUrl = process.env.DATABASE_URL ?? buildDatabaseUrl(defaultDatabaseConfig);

console.log(`Scaffold migrate placeholder against ${databaseUrl}`);
