import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function globalSetup(): Promise<void> {
  const repositoryRoot = process.cwd();
  const databaseUrl = execFileSync(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "resolve-test-database-url.mjs")],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  ).trim();

  process.env.DATABASE_URL = databaseUrl;
}
