export interface DatabaseConfig {
  database: string;
  host: string;
  password: string;
  port: number;
  user: string;
}

export const defaultDatabaseConfig: DatabaseConfig = {
  database: "agent_registry",
  host: "postgres",
  password: "registry",
  port: 5432,
  user: "registry",
};

export function buildDatabaseUrl(config: DatabaseConfig): string {
  return `postgres://${config.user}:${config.password}@${config.host}:${config.port}/${config.database}`;
}
