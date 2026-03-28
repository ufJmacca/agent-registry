import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { fileURLToPath } from "node:url";

const { Client } = pg;
const defaultDatabaseUrl = "postgres://registry:registry@postgres:5432/agent_registry";
const defaultRetryDelayMs = 500;
const defaultTimeoutMs = 30_000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createHostUrl(databaseUrl, hostname) {
  const url = new URL(databaseUrl);
  url.hostname = hostname;
  return url.toString();
}

export function redactDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);

  if (url.username.length > 0) {
    url.username = "redacted";
  }

  if (url.password.length > 0) {
    url.password = "redacted";
  }

  return url.toString();
}

export function buildCandidateUrls(requestedDatabaseUrl) {
  const candidateUrls = [requestedDatabaseUrl];

  if (new URL(requestedDatabaseUrl).hostname === "postgres") {
    candidateUrls.push(createHostUrl(requestedDatabaseUrl, "host.docker.internal"));
    candidateUrls.push(createHostUrl(requestedDatabaseUrl, "127.0.0.1"));
  }

  return candidateUrls;
}

async function hostnameResolves(hostname) {
  if (hostname === "localhost" || net.isIP(hostname) !== 0) {
    return true;
  }

  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

export async function canUseDatabase(databaseUrl) {
  const url = new URL(databaseUrl);

  if (!(await hostnameResolves(url.hostname))) {
    return false;
  }

  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1_000,
    query_timeout: 1_000,
    statement_timeout: 1_000,
  });
  const hardTimeoutMs = 1_500;

  return new Promise((resolve) => {
    let settled = false;

    const finalize = async (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(hardTimeout);
      await client.end().catch(() => {});
      resolve(result);
    };

    const hardTimeout = setTimeout(() => {
      client.connection?.stream?.destroy();
      void finalize(false);
    }, hardTimeoutMs);

    void (async () => {
      try {
        await client.connect();

        const { rows } = await client.query(
          "select current_database() as database_name, current_user as user_name",
        );
        const row = rows[0] ?? {};
        const expectedDatabaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
        const expectedUserName = decodeURIComponent(url.username);

        await finalize(
          row.database_name === expectedDatabaseName &&
            (expectedUserName.length === 0 || row.user_name === expectedUserName),
        );
      } catch {
        await finalize(false);
      }
    })();
  });
}

export function tryStartComposePostgres() {
  try {
    execFileSync("docker", ["compose", "up", "-d", "postgres"], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr ?? "") : "";
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    throw new Error(`Failed to start compose postgres: ${message}`);
  }
}

async function waitForAnyUsableDatabase(candidates, options) {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await options.validateDatabaseUrl(candidate)) {
        return candidate;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
  }

  return null;
}

export async function resolveTestDatabaseUrl(options = {}) {
  const requestedDatabaseUrl =
    options.requestedDatabaseUrl?.trim() || process.env.DATABASE_URL?.trim() || defaultDatabaseUrl;
  const candidateUrls = buildCandidateUrls(requestedDatabaseUrl);
  const validateDatabaseUrl = options.validateDatabaseUrl ?? canUseDatabase;
  const startComposePostgres = options.startComposePostgres ?? tryStartComposePostgres;
  const retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  let reachableDatabaseUrl = await waitForAnyUsableDatabase(candidateUrls, {
    retryDelayMs,
    timeoutMs,
    validateDatabaseUrl,
  });

  if (reachableDatabaseUrl === null) {
    await startComposePostgres();
    reachableDatabaseUrl = await waitForAnyUsableDatabase(candidateUrls, {
      retryDelayMs,
      timeoutMs,
      validateDatabaseUrl,
    });
  }

  if (reachableDatabaseUrl === null) {
    const redactedCandidateUrls = candidateUrls.map(redactDatabaseUrl);
    throw new Error(
      `Unable to authenticate with a test database using ${redactedCandidateUrls.join(" or ")} after starting compose postgres.`,
    );
  }

  return reachableDatabaseUrl;
}

async function main() {
  try {
    process.stdout.write(await resolveTestDatabaseUrl());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
