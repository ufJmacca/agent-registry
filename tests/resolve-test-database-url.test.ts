import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  buildCandidateUrls,
  canUseDatabase,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
} from "../scripts/resolve-test-database-url.mjs";

async function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("Expected an IPv4 test server address"));
        return;
      }

      resolve(address.port);
    });
  });
}

async function close(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

test("buildCandidateUrls adds host fallbacks for the compose postgres alias", () => {
  const requestedDatabaseUrl = "postgres://registry:registry@postgres:5432/agent_registry";

  assert.deepEqual(buildCandidateUrls(requestedDatabaseUrl), [
    requestedDatabaseUrl,
    "postgres://registry:registry@host.docker.internal:5432/agent_registry",
    "postgres://registry:registry@127.0.0.1:5432/agent_registry",
  ]);
});

test("redactDatabaseUrl removes embedded credentials while preserving the endpoint", () => {
  assert.equal(
    redactDatabaseUrl("postgres://registry:secret@postgres:5432/agent_registry"),
    "postgres://redacted:redacted@postgres:5432/agent_registry",
  );
  assert.equal(
    redactDatabaseUrl("postgres://registry@postgres:5432/agent_registry"),
    "postgres://redacted@postgres:5432/agent_registry",
  );
  assert.equal(
    redactDatabaseUrl("postgres://postgres:5432/agent_registry"),
    "postgres://postgres:5432/agent_registry",
  );
});

test("canUseDatabase rejects hosts that only accept raw TCP connections", async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  const port = await listen(server);

  try {
    assert.equal(
      await canUseDatabase(`postgres://registry:registry@127.0.0.1:${port}/agent_registry`),
      false,
    );
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await close(server);
  }
});

test("resolveTestDatabaseUrl retries after compose start and returns the first validated candidate", async () => {
  const requestedDatabaseUrl = "postgres://registry:registry@postgres:5432/agent_registry";
  const hostFallbackDatabaseUrl =
    "postgres://registry:registry@host.docker.internal:5432/agent_registry";
  const attempts: string[] = [];
  let composeStarted = false;

  const resolvedDatabaseUrl = await resolveTestDatabaseUrl({
    requestedDatabaseUrl,
    retryDelayMs: 0,
    timeoutMs: 25,
    async startComposePostgres() {
      composeStarted = true;
    },
    async validateDatabaseUrl(candidate) {
      attempts.push(candidate);
      return composeStarted && candidate === hostFallbackDatabaseUrl;
    },
  });

  assert.equal(resolvedDatabaseUrl, hostFallbackDatabaseUrl);
  assert.ok(composeStarted);
  assert.ok(attempts.includes(requestedDatabaseUrl));
  assert.ok(attempts.includes(hostFallbackDatabaseUrl));
});

test("resolveTestDatabaseUrl surfaces compose startup failures immediately", async () => {
  await assert.rejects(
    resolveTestDatabaseUrl({
      requestedDatabaseUrl: "postgres://registry:registry@postgres:5432/agent_registry",
      retryDelayMs: 0,
      timeoutMs: 25,
      async startComposePostgres() {
        throw new Error("docker compose is unavailable");
      },
      async validateDatabaseUrl() {
        return false;
      },
    }),
    /Failed to start compose postgres|docker compose is unavailable/,
  );
});

test("resolveTestDatabaseUrl redacts credentials from authentication failure output", async () => {
  const requestedDatabaseUrl = "postgres://secret-user:secret-pass@postgres:5432/agent_registry";

  await assert.rejects(
    resolveTestDatabaseUrl({
      requestedDatabaseUrl,
      retryDelayMs: 0,
      timeoutMs: 25,
      async startComposePostgres() {},
      async validateDatabaseUrl() {
        return false;
      },
    }),
    (error) => {
      assert.match(error.message, /Unable to authenticate with a test database using/);
      assert.match(error.message, /redacted:redacted@postgres:5432\/agent_registry/);
      assert.doesNotMatch(error.message, /secret-user/);
      assert.doesNotMatch(error.message, /secret-pass/);
      return true;
    },
  );
});
