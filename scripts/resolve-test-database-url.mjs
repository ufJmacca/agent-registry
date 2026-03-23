import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultDatabaseUrl = "postgres://registry:registry@postgres:5432/agent_registry";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createHostUrl(databaseUrl, hostname) {
  const url = new URL(databaseUrl);
  url.hostname = hostname;
  return url.toString();
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

async function canConnect(databaseUrl) {
  const url = new URL(databaseUrl);
  const port = Number(url.port || "5432");

  if (!(await hostnameResolves(url.hostname))) {
    return false;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: url.hostname,
      port,
    });

    const finalize = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(1_000);
    socket.once("connect", () => finalize(true));
    socket.once("error", () => finalize(false));
    socket.once("timeout", () => finalize(false));
  });
}

function tryStartComposePostgres() {
  try {
    execFileSync("docker", ["compose", "up", "-d", "postgres"], {
      cwd: repositoryRoot,
      stdio: "pipe",
    });
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr ?? "") : "";
    const message = stderr.trim() || (error instanceof Error ? error.message : String(error));
    console.error(`Failed to start compose postgres: ${message}`);
  }
}

async function waitForAnyReachable(candidates) {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      if (await canConnect(candidate)) {
        return candidate;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return null;
}

const requestedDatabaseUrl = process.env.DATABASE_URL?.trim() || defaultDatabaseUrl;
const candidateUrls = [requestedDatabaseUrl];

if (new URL(requestedDatabaseUrl).hostname === "postgres") {
  candidateUrls.push(createHostUrl(requestedDatabaseUrl, "host.docker.internal"));
  candidateUrls.push(createHostUrl(requestedDatabaseUrl, "127.0.0.1"));
}

let reachableDatabaseUrl = await waitForAnyReachable(candidateUrls);

if (reachableDatabaseUrl === null) {
  tryStartComposePostgres();
  reachableDatabaseUrl = await waitForAnyReachable(candidateUrls);
}

if (reachableDatabaseUrl === null) {
  console.error(
    `Unable to reach a test database using ${candidateUrls.join(" or ")} after starting compose postgres.`,
  );
  process.exit(1);
}

process.stdout.write(reachableDatabaseUrl);
