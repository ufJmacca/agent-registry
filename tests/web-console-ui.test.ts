import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { PrincipalResolver } from "../packages/auth/src/index.ts";
import { loadRegistryConfig, type RegistryConfig } from "../packages/config/src/index.ts";
import {
  KyselyAgentAdminDetailRepository,
  KyselyAgentDraftRegistrationRepository,
  KyselyAgentReviewRepository,
  KyselyBootstrapRepository,
  KyselyHealthRepository,
  KyselyPublicationTelemetryRepository,
  KyselyTenantEnvironmentRepository,
  KyselyTenantMembershipLookup,
  KyselyTenantRepository,
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  type AgentRegistryDb,
} from "../packages/db/src/index.ts";
import { bootstrapFromConfig } from "../apps/api/src/bootstrap/index.ts";
import { AgentDraftRegistrationService } from "../apps/api/src/modules/agents/service.ts";
import { AgentVersionReviewService } from "../apps/api/src/modules/review/service.ts";
import { createWebRequestListener } from "../apps/web/src/http.ts";

const { Pool } = pg;

const integrationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";

interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

interface EmptyRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
}

interface WebConsoleContext extends FreshRegistryDatabase {
  baseUrl: string;
  close(): Promise<void>;
  config: RegistryConfig;
}

interface PendingVersionFixture {
  agentId: string;
  versionId: string;
}

function createIsolatedDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createFreshRegistryDatabase(): Promise<FreshRegistryDatabase> {
  const databaseName = `agent_registry_test_${randomUUID().replaceAll("-", "_")}`;
  const adminPool = new Pool({
    connectionString: createIsolatedDatabaseUrl(integrationDatabaseUrl, "postgres"),
  });

  await adminPool.query(`create database "${databaseName}" template template0`);

  const databaseUrl = createIsolatedDatabaseUrl(integrationDatabaseUrl, databaseName);
  const db = createKyselyDb(databaseUrl);

  try {
    await migrateToLatest(db);

    return {
      async cleanup() {
        await destroyKyselyDb(db);
        await adminPool.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [databaseName],
        );
        await adminPool.query(`drop database if exists "${databaseName}"`);
        await adminPool.end();
      },
      databaseUrl,
      db,
    };
  } catch (error) {
    await destroyKyselyDb(db);
    await adminPool.query(`drop database if exists "${databaseName}"`);
    await adminPool.end();
    throw error;
  }
}

async function createEmptyRegistryDatabase(): Promise<EmptyRegistryDatabase> {
  const databaseName = `agent_registry_test_${randomUUID().replaceAll("-", "_")}`;
  const adminPool = new Pool({
    connectionString: createIsolatedDatabaseUrl(integrationDatabaseUrl, "postgres"),
  });

  try {
    await adminPool.query(`create database "${databaseName}" template template0`);
  } catch (error) {
    await adminPool.end();
    throw error;
  }

  return {
    async cleanup() {
      await adminPool.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`drop database if exists "${databaseName}"`);
      await adminPool.end();
    },
    databaseUrl: createIsolatedDatabaseUrl(integrationDatabaseUrl, databaseName),
  };
}

async function createWebConsoleContext(options: {
  bootstrapManifest?: string;
  deploymentMode: "hosted" | "self-hosted";
  reviewServiceOptions?: {
    enqueuePublicationProbe?: (publicationId: string) => Promise<void>;
    resolveProbeHostname?: (hostname: string) => Promise<string[]>;
  };
}): Promise<WebConsoleContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-web-console-"));
  const manifestPath = path.join(tempDir, "bootstrap.yaml");

  try {
    const manifest =
      options.bootstrapManifest ??
      (options.deploymentMode === "self-hosted"
        ? [
            "tenants:",
            "  - tenantId: tenant-self-hosted",
            "    displayName: Tenant Self Hosted",
            "    environments: [dev, prod]",
            "    memberships:",
            "      - subjectId: admin-self-hosted",
            "        roles: [tenant-admin]",
            "      - subjectId: publisher-self-hosted",
            "        roles: [publisher]",
            "",
          ].join("\n")
        : [
            "tenants:",
            "  - tenantId: tenant-alpha",
            "    displayName: Tenant Alpha",
            "    environments: [dev, prod, staging]",
            "    memberships:",
            "      - subjectId: admin-alpha",
            "        roles: [tenant-admin]",
            "      - subjectId: publisher-alpha",
            "        roles: [publisher]",
            "      - subjectId: publisher-bravo",
            "        roles: [publisher]",
            "  - tenantId: tenant-beta",
            "    displayName: Tenant Beta",
            "    environments: [test]",
            "    memberships:",
            "      - subjectId: admin-beta",
            "        roles: [tenant-admin]",
            "",
          ].join("\n"));

    await writeFile(manifestPath, manifest, "utf8");

    const config = loadRegistryConfig(
      options.deploymentMode === "self-hosted"
        ? {
            DATABASE_URL: database.databaseUrl,
            DEPLOYMENT_MODE: "self-hosted",
            SELF_HOSTED_BOOTSTRAP_FILE: manifestPath,
          }
        : {
            DATABASE_URL: database.databaseUrl,
            DEPLOYMENT_MODE: "hosted",
            HOSTED_BOOTSTRAP_FILE: manifestPath,
          },
    );

    await bootstrapFromConfig(config, new KyselyBootstrapRepository(database.db));

    const server = http.createServer(
      createWebRequestListener({
        config,
        db: database.db,
        reviewServiceOptions: {
          resolveProbeHostname:
            options.reviewServiceOptions?.resolveProbeHostname ?? (async () => ["198.51.100.20"]),
          enqueuePublicationProbe: options.reviewServiceOptions?.enqueuePublicationProbe,
        },
      }),
    );

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected an IPv4 test server address");
    }

    return {
      ...database,
      baseUrl: `http://127.0.0.1:${address.port}`,
      config,
      async close() {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
        await rm(tempDir, { force: true, recursive: true });
        await database.cleanup();
      },
    };
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true });
    await database.cleanup();
    throw error;
  }
}

function createRawCard(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      capabilities: ["card-search"],
      invocationEndpoint: "https://agent.example.com/invoke",
      name: "Case Resolver",
      summary: "Handles support case routing.",
      tags: ["card-tag"],
      ...overrides,
    },
    null,
    2,
  );
}

function getRedirectLocation(response: Response): string {
  const location = response.headers.get("location");

  if (location === null) {
    throw new Error(`Expected redirect location but received status ${response.status}`);
  }

  return location;
}

function assertUsesConsoleDocument(html: string): void {
  const headMatch = html.match(/<head>([\s\S]*?)<\/head>/);

  assert.notEqual(headMatch, null, "Expected the response to include a document head.");
  const [, headHtml] = headMatch;

  assert.match(
    headHtml,
    /<link rel="preload" href="\/assets\/fonts\/inter-variable\.woff2" as="font" type="font\/woff2"\s*\/?>/,
  );
  assert.match(
    headHtml,
    /<link rel="preload" href="\/assets\/fonts\/manrope-variable\.woff2" as="font" type="font\/woff2"\s*\/?>/,
  );
  assert.match(headHtml, /<link rel="stylesheet" href="\/assets\/console\.css"\s*\/?>/);
  assert.doesNotMatch(headHtml, /<(?:link|script)\b[^>]+\b(?:href|src)=["'](?:https?:)?\/\//);
  assert.doesNotMatch(html, /<style>/);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertShell(
  html: string,
  options: {
    currentNavHref?: string;
    page: string;
    shell: "authenticated" | "public";
  },
): void {
  assert.match(
    html,
    new RegExp(
      `data-shell="${escapeRegExp(options.shell)}"[^>]*data-page="${escapeRegExp(options.page)}"`,
    ),
  );

  if (options.currentNavHref !== undefined) {
    assert.match(
      html,
      new RegExp(
        `<a[^>]+href="${escapeRegExp(options.currentNavHref)}"[^>]+aria-current="page"`,
      ),
    );
  }
}

function assertPublicLandingLayout(html: string): void {
  assertUsesConsoleDocument(html);
  assertShell(html, {
    page: "sign-in",
    shell: "public",
  });
  assert.match(html, /Architectural Precision/);
  assert.match(html, /data-public-panel="access"/);
  assert.match(html, /data-public-panel="setup"/);
}

function getNamedSelect(html: string, name: string): {
  content: string;
  openTag: string;
} {
  const match = html.match(
    new RegExp(
      `(?<openTag><select[^>]+name="${escapeRegExp(name)}"[^>]*>)(?<content>[\\s\\S]*?)</select>`,
    ),
  );

  if (match?.groups === undefined) {
    throw new Error(`Expected a <select> named "${name}".`);
  }

  return {
    content: match.groups.content,
    openTag: match.groups.openTag,
  };
}

function assertSessionSignInUnavailable(html: string): void {
  assert.doesNotMatch(html, /<form[^>]+action="\/session"[^>]*>/);
  assert.doesNotMatch(html, /\bname="tenantId"\b/);
  assert.doesNotMatch(html, /\bname="subjectId"\b/);
}

function assertEnabledSubmitButton(html: string): void {
  const match = html.match(/<button[^>]+type="submit"[^>]*>/);

  if (match === null) {
    throw new Error("Expected a submit button on the sign-in page.");
  }

  assert.doesNotMatch(match[0], /\bdisabled\b/);
}

function extractEnvironmentCatalogSurface(html: string): string {
  const match = html.match(
    /<section class="environment-surfaces">\s*<div class="environment-catalog card stack">([\s\S]*?)<\/div>\s*<aside class="environment-create card stack" id="environment-creation-panel">/,
  );

  assert.notEqual(match, null, "Expected the environment catalog surface.");
  const [, catalogHtml] = match;
  return catalogHtml;
}

function extractEnvironmentCatalogList(html: string): string {
  const catalogHtml = extractEnvironmentCatalogSurface(html);
  const match = catalogHtml.match(/<div class="environment-catalog__list">([\s\S]*?)<\/div>\s*$/);

  assert.notEqual(match, null, "Expected the environment catalog list.");
  const [, catalogListHtml] = match;
  return catalogListHtml;
}

function extractEnvironmentCreationPanel(html: string): string {
  const match = html.match(
    /<aside class="environment-create card stack" id="environment-creation-panel">([\s\S]*?)<\/aside>/,
  );

  assert.notEqual(match, null, "Expected the environment creation panel.");
  const [, createPanelHtml] = match;
  return createPanelHtml;
}

async function listTenantEnvironmentKeys(
  db: AgentRegistryDb,
  tenantId: string,
): Promise<string[]> {
  const environments = await new KyselyTenantEnvironmentRepository(db).listForTenant(tenantId);

  return environments.map((environment) => environment.environmentKey);
}

function getTextareaContents(html: string, name: string): string {
  const match = html.match(
    new RegExp(`<textarea[^>]+name="${escapeRegExp(name)}"[^>]*>([\\s\\S]*?)<\\/textarea>`),
  );

  if (match === null) {
    throw new Error(`Expected textarea ${name} to be rendered.`);
  }

  return match[1];
}

function matchHtmlFragment(html: string, pattern: RegExp, failureMessage: string): string {
  const match = html.match(pattern);

  assert.ok(match, failureMessage);
  return match[0];
}

function countHtmlMatches(html: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return html.match(new RegExp(pattern.source, flags))?.length ?? 0;
}

function extractReviewQueueEntryHtml(html: string, entryKey: string): string {
  return matchHtmlFragment(
    html,
    new RegExp(`<li[^>]+data-review-entry="${escapeRegExp(entryKey)}"[^>]*>[\\s\\S]*?<\\/li>`),
    `Expected review queue row for ${entryKey}`,
  );
}

function extractReviewQueueSectionHtml(html: string): string {
  return matchHtmlFragment(
    html,
    /<section class="review-queue stack">[\s\S]*?<\/section>/,
    "Expected review queue section",
  );
}

function assertReviewQueueOmitsUnsupportedControls(html: string, entryCount: number): void {
  const reviewQueueSectionHtml = extractReviewQueueSectionHtml(html);
  const expectedReviewQueueStructure =
    entryCount === 0
      ? /^<section class="review-queue stack">\s*<header class="review-queue__hero card">[\s\S]*?<\/header>\s*<section class="review-queue__empty card stack">[\s\S]*?<\/section>\s*<\/section>$/
      : /^<section class="review-queue stack">\s*<header class="review-queue__hero card">[\s\S]*?<\/header>\s*<ol class="review-queue__list" aria-label="Pending review decisions">[\s\S]*?<\/ol>\s*<\/section>$/;

  assert.match(
    reviewQueueSectionHtml,
    expectedReviewQueueStructure,
    entryCount === 0
      ? "Expected review queue to render only the hero and empty state"
      : "Expected review queue to render only the hero and decision list",
  );
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<header\b/i), 1);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<section\b/i), entryCount === 0 ? 2 : 1);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<aside\b/i), 0);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<nav\b/i), 0);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<ol\b/i), entryCount === 0 ? 0 : 1);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<ul\b/i), 0);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<a\b/i), entryCount);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<button\b/i), entryCount * 2);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<form\b/), entryCount * 2);
  assert.equal(countHtmlMatches(reviewQueueSectionHtml, /<textarea\b/), entryCount);
  assert.equal(
    countHtmlMatches(reviewQueueSectionHtml, /<input\b(?![^>]*type="hidden")[^>]*>/i),
    0,
  );
  assert.doesNotMatch(reviewQueueSectionHtml, /<input\b[^>]*type="search"/i);
  assert.doesNotMatch(reviewQueueSectionHtml, /\brole="search"\b/i);
  assert.doesNotMatch(reviewQueueSectionHtml, /<select\b/i);
  assert.doesNotMatch(reviewQueueSectionHtml, /\brole="button"\b/i);
  assert.doesNotMatch(reviewQueueSectionHtml, /\brole="link"\b/i);
  assert.doesNotMatch(reviewQueueSectionHtml, /\brole="toolbar"\b/i);
  assert.doesNotMatch(reviewQueueSectionHtml, /\brole="tablist"\b/i);
  assert.doesNotMatch(reviewQueueSectionHtml, /\brole="tab"\b/i);
}

function assertReviewQueueEntry(
  html: string,
  options: {
    displayName: string;
    fixture: PendingVersionFixture;
    tenantId: string;
  },
): void {
  const entryKey = `${options.fixture.agentId}:${options.fixture.versionId}`;
  const versionDetailHref = `/tenants/${options.tenantId}/agents/${options.fixture.agentId}/versions/${options.fixture.versionId}`;
  const rejectReasonId = `review-reject-reason-${options.fixture.agentId}-${options.fixture.versionId}`;
  const rowHtml = extractReviewQueueEntryHtml(html, entryKey);

  assert.equal(countHtmlMatches(rowHtml, /<section\b/i), 0);
  assert.equal(countHtmlMatches(rowHtml, /<aside\b/i), 0);
  assert.equal(countHtmlMatches(rowHtml, /<nav\b/i), 0);
  assert.equal(countHtmlMatches(rowHtml, /<ol\b/i), 0);
  assert.equal(countHtmlMatches(rowHtml, /<ul\b/i), 0);
  assert.equal(countHtmlMatches(rowHtml, /<a\b/i), 1);
  assert.equal(countHtmlMatches(rowHtml, /<button\b/i), 2);
  assert.equal(countHtmlMatches(rowHtml, /<textarea\b/i), 1);
  assert.equal(countHtmlMatches(rowHtml, /<input\b(?![^>]*type="hidden")[^>]*>/i), 0);
  assert.equal(countHtmlMatches(rowHtml, /<select\b/i), 0);
  assert.doesNotMatch(rowHtml, /\brole="button"\b/i);
  assert.doesNotMatch(rowHtml, /\brole="link"\b/i);
  const approveFormHtml = matchHtmlFragment(
    rowHtml,
    new RegExp(
      `<form[^>]+action="${escapeRegExp(`${versionDetailHref}/approve`)}"[^>]*>[\\s\\S]*?<\\/form>`,
    ),
    `Expected approve form inside review queue row ${entryKey}`,
  );
  const rejectFormHtml = matchHtmlFragment(
    rowHtml,
    new RegExp(
      `<form[^>]+action="${escapeRegExp(`${versionDetailHref}/reject`)}"[^>]*>[\\s\\S]*?<\\/form>`,
    ),
    `Expected reject form inside review queue row ${entryKey}`,
  );

  assert.match(
    rowHtml,
    new RegExp(`<h2>${escapeRegExp(options.displayName)}<\\/h2>`),
  );
  assert.match(
    rowHtml,
    new RegExp(`<a[^>]+href="${escapeRegExp(versionDetailHref)}"[^>]*>Inspect version detail<\\/a>`),
  );
  assert.match(approveFormHtml, /method="post"/);
  assert.match(
    approveFormHtml,
    /<button[^>]+type="submit"[^>]*>Approve<\/button>/,
  );
  assert.match(rejectFormHtml, /method="post"/);
  assert.match(
    rejectFormHtml,
    new RegExp(`<label[^>]+for="${escapeRegExp(rejectReasonId)}"[^>]*>Reject reason<\\/label>`),
  );
  assert.match(
    rejectFormHtml,
    new RegExp(
      `<textarea[^>]+id="${escapeRegExp(rejectReasonId)}"[^>]+name="reason"[^>]+required`,
    ),
  );
  assert.match(
    rejectFormHtml,
    /<button[^>]+type="submit"[^>]*>Reject<\/button>/,
  );
}

test("shell stylesheet preserves the 960px mobile navigation breakpoint rules", async () => {
  // Arrange
  const css = await readFile(path.resolve("apps/web/assets/console.css"), "utf8");

  // Assert
  assert.match(
    css,
    /@media \(max-width: 960px\)\s*\{[\s\S]*?\.console-public-shell,\s*\.console-workspace\s*\{\s*grid-template-columns:\s*1fr;\s*\}/,
  );
  assert.match(
    css,
    /@media \(max-width: 960px\)\s*\{[\s\S]*?\.console-nav\s*\{\s*position:\s*static;\s*top:\s*auto;\s*\}/,
  );
  assert.match(
    css,
    /@media \(max-width: 960px\)\s*\{[\s\S]*?\.console-nav__group\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow-x:\s*auto;[\s\S]*?white-space:\s*nowrap;[\s\S]*?\}/,
  );
});

test("dashboard stylesheet defines a responsive bento grid", async () => {
  // Arrange
  const css = await readFile(path.resolve("apps/web/assets/console.css"), "utf8");

  // Assert
  assert.match(
    css,
    /\.dashboard-grid\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/,
  );
  assert.match(
    css,
    /\.dashboard-panel--hero\s*\{[\s\S]*?grid-column:\s*span 2;/,
  );
  assert.match(
    css,
    /@media \(max-width: 960px\)\s*\{[\s\S]*?\.dashboard-grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/,
  );
});

test("draft registration stylesheet preserves narrow-width readability affordances", async () => {
  // Arrange
  const css = await readFile(path.resolve("apps/web/assets/console.css"), "utf8");

  // Assert
  assert.match(
    css,
    /\.draft-code-input\s*\{[\s\S]*?min-height:\s*14rem;[\s\S]*?overflow-x:\s*auto;[\s\S]*?white-space:\s*pre;[\s\S]*?\}/,
  );
  assert.match(css, /\.draft-file-input\s*\{[\s\S]*?max-width:\s*100%;[\s\S]*?\}/);
  assert.match(
    css,
    /@media \(max-width: 960px\)\s*\{[\s\S]*?\.draft-hero,\s*\.draft-grid--metadata,\s*\.draft-grid--contracts,\s*\.draft-publication-panel__grid\s*\{\s*grid-template-columns:\s*1fr;\s*\}/,
  );
});

class BrowserSession {
  private readonly baseUrl: string;

  private readonly cookies = new Map<string, string>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async get(pathname: string): Promise<Response> {
    return this.request(pathname, {
      method: "GET",
    });
  }

  async postForm(pathname: string, formData: FormData): Promise<Response> {
    return this.request(pathname, {
      body: formData,
      method: "POST",
    });
  }

  async postUrlEncoded(pathname: string, values: Record<string, string>): Promise<Response> {
    return this.request(pathname, {
      body: new URLSearchParams(values),
      method: "POST",
    });
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookieHeader = [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    if (cookieHeader !== "") {
      headers.set("cookie", cookieHeader);
    }

    const response = await fetch(new URL(pathname, this.baseUrl), {
      ...init,
      headers,
      redirect: "manual",
    });
    const setCookieHeader =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];

    for (const cookie of setCookieHeader) {
      const [pair] = cookie.split(";", 1);
      const separatorIndex = pair.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const name = pair.slice(0, separatorIndex);
      const value = pair.slice(separatorIndex + 1);

      if (value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }

    return response;
  }
}

async function signIn(
  browser: BrowserSession,
  tenantId: string,
  subjectId: string,
): Promise<void> {
  const response = await browser.postUrlEncoded("/session", {
    subjectId,
    tenantId,
  });

  assert.equal(response.status, 303);
  assert.equal(getRedirectLocation(response), "/console");
}

async function resolvePrincipal(
  db: AgentRegistryDb,
  tenantId: string,
  subjectId: string,
) {
  return new PrincipalResolver(new KyselyTenantMembershipLookup(db)).resolve({
    auth: {
      subjectId,
    },
    tenantId,
  });
}

async function createPendingVersion(
  context: WebConsoleContext,
  input: {
    displayName: string;
    environments: string[];
    publisherId: string;
    summary: string;
    versionLabel: string;
  },
): Promise<PendingVersionFixture> {
  const principal = await resolvePrincipal(context.db, "tenant-alpha", input.publisherId);
  const draftService = new AgentDraftRegistrationService(
    new KyselyAgentDraftRegistrationRepository(context.db),
    new KyselyTenantEnvironmentRepository(context.db),
    new KyselyTenantRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      rawCardByteLimit: context.config.rawCardByteLimit,
      requireHttpsHealthEndpoints: context.config.healthProbe.requireHttps,
    },
  );
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      requireHttps: context.config.healthProbe.requireHttps,
      resolveProbeHostname: async () => ["198.51.100.20"],
    },
  );

  const draft = await draftService.createDraftAgent(principal, "tenant-alpha", {
    capabilities: ["shared-capability"],
    contextContract: [
      {
        description: "Selects the client partition.",
        example: "client-123",
        key: "client_id",
        required: true,
        type: "string",
      },
    ],
    displayName: input.displayName,
    headerContract: [
      {
        description: "Passes the calling user identifier.",
        name: "X-User-Id",
        required: true,
        source: "user.id",
      },
    ],
    publications: input.environments.map((environmentKey) => ({
      environmentKey,
      healthEndpointUrl: `https://${environmentKey}.health.example.com/status`,
      rawCard: createRawCard({
        capabilities: ["card-search", `${environmentKey}-capability`],
        name: input.displayName,
        summary: input.summary,
        tags: ["card-tag", environmentKey],
      }),
    })),
    requiredRoles: ["support-agent"],
    requiredScopes: ["tickets.read"],
    summary: input.summary,
    tags: ["shared-tag"],
    versionLabel: input.versionLabel,
  });

  await reviewService.submitVersion(principal, "tenant-alpha", draft.agentId, draft.versionId);

  return {
    agentId: draft.agentId,
    versionId: draft.versionId,
  };
}

async function approvePendingVersion(
  context: WebConsoleContext,
  fixture: PendingVersionFixture,
): Promise<void> {
  const principal = await resolvePrincipal(context.db, "tenant-alpha", "admin-alpha");
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      requireHttps: context.config.healthProbe.requireHttps,
      resolveProbeHostname: async () => ["198.51.100.20"],
    },
  );

  await reviewService.approveVersion(principal, "tenant-alpha", fixture.agentId, fixture.versionId);
}

async function seedHealthAndTelemetry(
  db: AgentRegistryDb,
  fixture: PendingVersionFixture,
): Promise<void> {
  const publication = await db
    .selectFrom("environment_publications")
    .select(["publication_id", "environment_key"])
    .where("tenant_id", "=", "tenant-alpha")
    .where("agent_id", "=", fixture.agentId)
    .where("version_id", "=", fixture.versionId)
    .where("environment_key", "=", "dev")
    .executeTakeFirstOrThrow();

  const healthRepository = new KyselyHealthRepository(db);
  const telemetryRepository = new KyselyPublicationTelemetryRepository(db);

  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:00:00Z",
    error: null,
    ok: true,
    publicationId: publication.publication_id,
    statusCode: 200,
  });
  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:01:00Z",
    error: "service unavailable",
    ok: false,
    publicationId: publication.publication_id,
    statusCode: 503,
  });
  await telemetryRepository.upsertPublicationTelemetry({
    agentId: fixture.agentId,
    environmentKey: publication.environment_key,
    errorCount: 1,
    invocationCount: 12,
    p50LatencyMs: 120,
    p95LatencyMs: 280,
    successCount: 11,
    tenantId: "tenant-alpha",
    versionId: fixture.versionId,
    windowEndedAt: "2026-03-13T10:15:00Z",
    windowStartedAt: "2026-03-13T10:00:00Z",
  });
}

test("dashboard surfaces only truthful data with role-sensitive console entry points", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const publisherBrowser = new BrowserSession(context.baseUrl);
  const adminBrowser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const approvedFixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });
    const otherPublisherFixture = await createPendingVersion(context, {
      displayName: "Escalation Router",
      environments: ["dev"],
      publisherId: "publisher-bravo",
      summary: "Routes escalations for a different publisher.",
      versionLabel: "v2",
    });

    await approvePendingVersion(context, approvedFixture);
    await signIn(publisherBrowser, "tenant-alpha", "publisher-alpha");
    await signIn(adminBrowser, "tenant-alpha", "admin-alpha");

    const publisherVersionHref =
      `/tenants/tenant-alpha/agents/${approvedFixture.agentId}/versions/${approvedFixture.versionId}`;
    const otherPublisherVersionHref =
      `/tenants/tenant-alpha/agents/${otherPublisherFixture.agentId}/versions/${otherPublisherFixture.versionId}`;
    const activeAgentHref = `/tenants/tenant-alpha/agents/${approvedFixture.agentId}`;

    // Act
    const publisherPage = await publisherBrowser.get("/console");
    const publisherHtml = await publisherPage.text();
    const adminPage = await adminBrowser.get("/console");
    const adminHtml = await adminPage.text();

    // Assert
    assert.equal(publisherPage.status, 200);
    assertShell(publisherHtml, {
      currentNavHref: "/console",
      page: "dashboard",
      shell: "authenticated",
    });
    assert.match(publisherHtml, /class="dashboard-grid"/);
    assert.match(publisherHtml, /<h1>System Overview<\/h1>/);
    assert.match(publisherHtml, /<h2>Tenant Context<\/h2>/);
    assert.match(
      publisherHtml,
      /dashboard-panel--primary[\s\S]*?href="\/tenants\/tenant-alpha\/drafts\/new"[\s\S]*?>New Draft Registration</,
    );
    assert.match(publisherHtml, /Tenant Alpha/);
    assert.match(publisherHtml, /tenant-alpha/);
    assert.match(publisherHtml, /publisher-alpha/);
    assert.match(publisherHtml, /publisher/);
    assert.match(publisherHtml, new RegExp(escapeRegExp(publisherVersionHref)));
    assert.doesNotMatch(publisherHtml, new RegExp(escapeRegExp(otherPublisherVersionHref)));
    assert.doesNotMatch(publisherHtml, /<h2>Active Agents<\/h2>/);
    assert.doesNotMatch(publisherHtml, />Environment Management</);
    assert.doesNotMatch(publisherHtml, />Review Queue</);
    assert.doesNotMatch(publisherHtml, />Settings</);
    assert.doesNotMatch(publisherHtml, />Support</);
    assert.doesNotMatch(publisherHtml, />API Status</);
    assert.doesNotMatch(publisherHtml, />New Agent</);

    assert.equal(adminPage.status, 200);
    assertShell(adminHtml, {
      currentNavHref: "/console",
      page: "dashboard",
      shell: "authenticated",
    });
    assert.match(adminHtml, /class="dashboard-grid"/);
    assert.match(adminHtml, /<h2>Tenant Context<\/h2>/);
    assert.match(adminHtml, /admin-alpha/);
    assert.match(
      adminHtml,
      /dashboard-panel--primary[\s\S]*?href="\/tenants\/tenant-alpha\/drafts\/new"[\s\S]*?>New Draft Registration</,
    );
    assert.match(
      adminHtml,
      /<a class="dashboard-panel dashboard-panel--navigation" href="\/tenants\/tenant-alpha\/environments">[\s\S]*?<h2>Environment Management<\/h2>/,
    );
    assert.match(
      adminHtml,
      /<a class="dashboard-panel dashboard-panel--navigation" href="\/tenants\/tenant-alpha\/review">[\s\S]*?<h2>Review Queue<\/h2>/,
    );
    assert.match(adminHtml, /<h2>Active Agents<\/h2>/);
    assert.match(adminHtml, new RegExp(escapeRegExp(activeAgentHref)));
    assert.match(adminHtml, new RegExp(escapeRegExp(publisherVersionHref)));
    assert.match(adminHtml, new RegExp(escapeRegExp(otherPublisherVersionHref)));
    assert.doesNotMatch(adminHtml, />Settings</);
    assert.doesNotMatch(adminHtml, />Support</);
    assert.doesNotMatch(adminHtml, />API Status</);
    assert.doesNotMatch(adminHtml, />New Agent</);
  } finally {
    await context.close();
  }
});

test("console root renders a setup page before schema bootstrap", async () => {
  const database = await createEmptyRegistryDatabase();
  const db = createKyselyDb(database.databaseUrl);
  const config = loadRegistryConfig(
    {
      DATABASE_URL: database.databaseUrl,
    },
    {
      requireBootstrapFile: false,
    },
  );
  const server = http.createServer(
    createWebRequestListener({
      config,
      db,
    }),
  );

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected an IPv4 test server address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assertPublicLandingLayout(html);
    assert.match(html, /Console Setup Pending/);
    assert.match(html, /Run migrations and load bootstrap tenant data to enable console sign-in\./);
    assert.doesNotMatch(html, /relation "tenant_memberships" does not exist/);
    assertSessionSignInUnavailable(html);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await destroyKyselyDb(db);
    await database.cleanup();
  }
});

test("console root renders a distinct setup page after schema bootstrap with no tenant data", async () => {
  const database = await createFreshRegistryDatabase();
  const config = loadRegistryConfig(
    {
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "hosted",
    },
    {
      requireBootstrapFile: false,
    },
  );
  const server = http.createServer(
    createWebRequestListener({
      config,
      db: database.db,
    }),
  );

  try {
    // Arrange
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected an IPv4 test server address");
    }

    // Act
    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = await response.text();

    // Assert
    assert.equal(response.status, 200);
    assertPublicLandingLayout(html);
    assert.match(html, /Console Setup Pending/);
    assert.match(html, /Bootstrap tenant and membership data to enable console sign-in\./);
    assert.doesNotMatch(html, /Run migrations and load bootstrap tenant data to enable console sign-in\./);
    assertSessionSignInUnavailable(html);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    await database.cleanup();
  }
});

test("hosted sign-in landing uses the editorial access-card layout and swaps memberships by tenant query", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const signInPage = await browser.get("/");
    const signInHtml = await signInPage.text();
    const tenantBetaPage = await browser.get("/?tenantId=tenant-beta");
    const tenantBetaHtml = await tenantBetaPage.text();
    const alphaSubjectSelect = getNamedSelect(signInHtml, "subjectId");
    const betaSubjectSelect = getNamedSelect(tenantBetaHtml, "subjectId");

    // Assert
    assert.equal(signInPage.status, 200);
    assert.equal(tenantBetaPage.status, 200);
    assertPublicLandingLayout(signInHtml);
    assert.match(signInHtml, /Registry Access/);
    assert.match(signInHtml, /<form[^>]+action="\/session"[^>]+method="post"/);
    assert.match(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(signInHtml, /<option value="tenant-alpha" selected/);
    assert.doesNotMatch(alphaSubjectSelect.openTag, /\bdisabled\b/);
    assert.match(alphaSubjectSelect.content, /<option value="admin-alpha"/);
    assert.match(alphaSubjectSelect.content, /<option value="publisher-alpha"/);
    assert.doesNotMatch(alphaSubjectSelect.content, /<option value="admin-beta"/);
    assertEnabledSubmitButton(signInHtml);
    assertPublicLandingLayout(tenantBetaHtml);
    assert.match(tenantBetaHtml, /<option value="tenant-beta" selected/);
    assert.doesNotMatch(betaSubjectSelect.openTag, /\bdisabled\b/);
    assert.match(betaSubjectSelect.content, /<option value="admin-beta"/);
    assert.doesNotMatch(betaSubjectSelect.content, /<option value="admin-alpha"/);
    assert.doesNotMatch(betaSubjectSelect.content, /<option value="publisher-alpha"/);
    assertEnabledSubmitButton(tenantBetaHtml);
  } finally {
    await context.close();
  }
});

test("hosted sign-in landing keeps the no-membership fallback truthful and non-interactive", async () => {
  const context = await createWebConsoleContext({
    bootstrapManifest: [
      "tenants:",
      "  - tenantId: tenant-alpha",
      "    displayName: Tenant Alpha",
      "    environments: [dev]",
      "    memberships:",
      "      - subjectId: admin-alpha",
      "        roles: [tenant-admin]",
      "  - tenantId: tenant-gamma",
      "    displayName: Tenant Gamma",
      "    environments: [test]",
      "    memberships: []",
      "",
    ].join("\n"),
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const response = await browser.get("/?tenantId=tenant-gamma");
    const html = await response.text();

    // Assert
    assert.equal(response.status, 200);
    assertPublicLandingLayout(html);
    assert.match(html, /<option value="tenant-gamma" selected/);
    assert.match(html, /No memberships available for Tenant Gamma\./);
    assert.match(html, /<select[^>]+name="subjectId"[^>]+disabled/);
    assert.match(html, /<button[^>]+type="submit"[^>]+disabled/);
  } finally {
    await context.close();
  }
});

test("existing console sessions redirect from the public landing page to /console", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    await signIn(browser, "tenant-alpha", "publisher-alpha");

    // Act
    const response = await browser.get("/");

    // Assert
    assert.equal(response.status, 303);
    assert.equal(getRedirectLocation(response), "/console");
  } finally {
    await context.close();
  }
});

test("console assets are served without a session and strictly allowlist repo-local presentation assets", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });

  try {
    // Arrange
    const cssUrl = new URL("/assets/console.css", context.baseUrl);
    const fontUrl = new URL("/assets/fonts/inter-variable.woff2", context.baseUrl);
    const rejectedAssetUrl = new URL("/assets/fonts/LICENSE-Inter.txt", context.baseUrl);

    // Act
    const cssResponse = await fetch(cssUrl, {
      redirect: "manual",
    });
    const css = await cssResponse.text();
    const fontResponse = await fetch(fontUrl, {
      redirect: "manual",
    });
    const fontBytes = new Uint8Array(await fontResponse.arrayBuffer());
    const rejectedAssetResponse = await fetch(rejectedAssetUrl, {
      redirect: "manual",
    });
    const rejectedAssetBody = await rejectedAssetResponse.text();

    // Assert
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get("content-type") ?? "", /^text\/css(?:;|$)/);
    assert.match(css, /@font-face/);
    assert.match(css, /url\("\/assets\/fonts\/inter-variable\.woff2"\)/);
    assert.match(css, /url\("\/assets\/fonts\/manrope-variable\.woff2"\)/);
    assert.doesNotMatch(css, /https?:\/\//);
    assert.equal(fontResponse.status, 200);
    assert.match(fontResponse.headers.get("content-type") ?? "", /^font\/woff2(?:;|$)/);
    assert.ok(fontBytes.byteLength > 0);
    assert.equal(rejectedAssetResponse.status, 404);
    assert.match(rejectedAssetResponse.headers.get("content-type") ?? "", /^text\/plain(?:;|$)/);
    assert.equal(rejectedAssetBody, "Not found.");
  } finally {
    await context.close();
  }
});

test("unexpected console failures return 500 without exposing internal messages", async () => {
  const config = loadRegistryConfig(
    {},
    {
      requireBootstrapFile: false,
    },
  );
  const server = http.createServer(
    createWebRequestListener({
      config,
      db: {
        selectFrom() {
          throw new Error("database offline");
        },
      } as unknown as AgentRegistryDb,
    }),
  );

  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected an IPv4 test server address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`);
    const html = await response.text();

    assert.equal(response.status, 500);
    assertUsesConsoleDocument(html);
    assert.match(html, /Internal server error\./);
    assert.doesNotMatch(html, /database offline/);
  } finally {
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
});

test("publisher console creates a multi-environment draft and submits it for review", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const signInPage = await browser.get("/");
    const signInHtml = await signInPage.text();
    const tenantBetaSignInPage = await browser.get("/?tenantId=tenant-beta");
    const tenantBetaSignInHtml = await tenantBetaSignInPage.text();

    await signIn(browser, "tenant-alpha", "publisher-alpha");

    const dashboardPage = await browser.get("/console");
    const dashboardHtml = await dashboardPage.text();
    const newDraftPage = await browser.get("/tenants/tenant-alpha/drafts/new");
    const newDraftHtml = await newDraftPage.text();
    const draftForm = new FormData();

    draftForm.set("versionLabel", "v1");
    draftForm.set("displayName", "Case Resolver");
    draftForm.set("summary", "Handles support case routing.");
    draftForm.set("capabilities", "shared-capability, case-routing");
    draftForm.set("tags", "shared-tag, routing");
    draftForm.set("requiredRoles", "support-agent");
    draftForm.set("requiredScopes", "tickets.read, tickets.write");
    draftForm.set(
      "headerContract",
      JSON.stringify([
        {
          description: "Passes the calling user identifier.",
          name: "X-User-Id",
          required: true,
          source: "user.id",
        },
      ]),
    );
    draftForm.set(
      "contextContract",
      JSON.stringify([
        {
          description: "Selects the client partition.",
          example: "client-123",
          key: "client_id",
          required: true,
          type: "string",
        },
      ]),
    );
    draftForm.set("publication:dev:enabled", "on");
    draftForm.set("publication:dev:healthEndpointUrl", "https://dev.health.example.com/status");
    draftForm.set(
      "publication:dev:rawCard",
      new File(
        [
          createRawCard({
            capabilities: ["card-search", "dev-capability"],
            name: "Case Resolver",
            summary: "Handles support case routing.",
            tags: ["card-tag", "dev"],
          }),
        ],
        "dev-card.json",
        {
          type: "application/json",
        },
      ),
    );
    draftForm.set("publication:prod:enabled", "on");
    draftForm.set("publication:prod:healthEndpointUrl", "https://prod.health.example.com/status");
    draftForm.set(
      "publication:prod:rawCard",
      new File(
        [
          createRawCard({
            capabilities: ["card-search", "prod-capability"],
            name: "Case Resolver",
            summary: "Handles support case routing.",
            tags: ["card-tag", "prod"],
          }),
        ],
        "prod-card.json",
        {
          type: "application/json",
        },
      ),
    );

    // Act
    const createDraftResponse = await browser.postForm("/tenants/tenant-alpha/drafts", draftForm);
    const draftLocation = getRedirectLocation(createDraftResponse);
    const draftDetailPage = await browser.get(draftLocation);
    const draftDetailHtml = await draftDetailPage.text();
    const routeMatch =
      /^\/tenants\/tenant-alpha\/agents\/([^/]+)\/versions\/([^/]+)$/.exec(draftLocation);

    if (routeMatch === null) {
      throw new Error(`Unexpected draft redirect location '${draftLocation}'`);
    }

    const submitResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${routeMatch[1]}/versions/${routeMatch[2]}/submit`,
      {},
    );
    const submittedDetailPage = await browser.get(draftLocation);
    const submittedDetailHtml = await submittedDetailPage.text();
    const environmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const environmentsHtml = await environmentsPage.text();

    // Assert
    assert.equal(signInPage.status, 200);
    assert.equal(tenantBetaSignInPage.status, 200);
    assertShell(signInHtml, {
      page: "sign-in",
      shell: "public",
    });
    assert.match(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(signInHtml, /admin-alpha/);
    assert.match(signInHtml, /publisher-alpha/);
    assert.doesNotMatch(signInHtml, /admin-beta/);
    assert.match(tenantBetaSignInHtml, /admin-beta/);
    assert.doesNotMatch(tenantBetaSignInHtml, /admin-alpha/);
    assert.doesNotMatch(tenantBetaSignInHtml, /publisher-alpha/);
    assertShell(dashboardHtml, {
      currentNavHref: "/console",
      page: "dashboard",
      shell: "authenticated",
    });
    assert.match(dashboardHtml, /data-visual-mask="true"/);
    assert.match(dashboardHtml, /<form[^>]+action="\/session\/logout"[^>]+method="post"/);
    assert.match(dashboardHtml, /New Draft Registration/);
    assert.doesNotMatch(dashboardHtml, /Review Queue/);
    assert.equal(newDraftPage.status, 200);
    assertShell(newDraftHtml, {
      currentNavHref: "/tenants/tenant-alpha/drafts/new",
      page: "draft-registration",
      shell: "authenticated",
    });
    assert.match(newDraftHtml, /type="file"/);
    assert.match(newDraftHtml, /publication:dev:enabled/);
    assert.equal(createDraftResponse.status, 303);
    assertShell(draftDetailHtml, {
      currentNavHref: draftLocation,
      page: "version-detail",
      shell: "authenticated",
    });
    assert.match(draftDetailHtml, /Approval state: draft/);
    assert.match(draftDetailHtml, /Environment: dev/);
    assert.match(draftDetailHtml, /Environment: prod/);
    assert.match(draftDetailHtml, /X-User-Id/);
    assert.match(draftDetailHtml, /client_id/);
    assert.equal(submitResponse.status, 303);
    assert.equal(getRedirectLocation(submitResponse), draftLocation);
    assertShell(submittedDetailHtml, {
      currentNavHref: draftLocation,
      page: "version-detail",
      shell: "authenticated",
    });
    assert.match(submittedDetailHtml, /Approval state: pending_review/);
    assert.equal(environmentsPage.status, 403);
    assert.match(environmentsHtml, /Tenant admin role is required/);
  } finally {
    await context.close();
  }
});

test("publisher console renders grouped draft registration sections with preserved contract defaults and multipart field names", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);
  const hostedEnvironmentKeys = ["dev", "prod", "staging"];

  try {
    // Arrange
    await signIn(browser, "tenant-alpha", "publisher-alpha");

    // Act
    const response = await browser.get("/tenants/tenant-alpha/drafts/new");
    const html = await response.text();
    const generalMetadataIndex = html.indexOf("General Metadata");
    const sharedContractsIndex = html.indexOf("Shared Contracts");
    const environmentPublicationsIndex = html.indexOf("Environment Publications");
    const actionFooterIndex = html.indexOf('data-draft-action-footer="true"');
    const headerContract = getTextareaContents(html, "headerContract");
    const contextContract = getTextareaContents(html, "contextContract");
    const publicationPanels = html.match(/data-draft-publication-panel="[^"]+"/g) ?? [];

    // Assert
    assert.equal(response.status, 200);
    assert.match(
      html,
      /<form[^>]+action="\/tenants\/tenant-alpha\/drafts"[^>]+method="post"[^>]+enctype="multipart\/form-data"[^>]*>/,
    );
    assert.match(html, /data-draft-form="true"/);
    assert.match(html, /data-draft-section="general-metadata"/);
    assert.match(html, /data-draft-section="shared-contracts"/);
    assert.match(html, /data-draft-section="environment-publications"/);
    assert.equal(publicationPanels.length, hostedEnvironmentKeys.length);
    assert.match(html, /data-draft-action-footer="true"/);
    assert.ok(generalMetadataIndex >= 0);
    assert.ok(sharedContractsIndex > generalMetadataIndex);
    assert.ok(environmentPublicationsIndex > sharedContractsIndex);
    assert.ok(actionFooterIndex > environmentPublicationsIndex);
    assert.match(html, /name="versionLabel"/);
    assert.match(html, /name="displayName"/);
    assert.match(html, /name="summary"/);
    assert.match(html, /name="capabilities"/);
    assert.match(html, /name="tags"/);
    assert.match(html, /name="requiredRoles"/);
    assert.match(html, /name="requiredScopes"/);
    assert.match(html, /name="headerContract"/);
    assert.match(html, /name="contextContract"/);
    assert.match(
      html,
      /<textarea class="draft-code-input" name="headerContract" rows="10" spellcheck="false" wrap="off">/,
    );
    assert.match(
      html,
      /<textarea class="draft-code-input" name="contextContract" rows="10" spellcheck="false" wrap="off">/,
    );
    assert.equal(
      headerContract,
      [
        "[",
        "  {",
        '    "name": "X-User-Id",',
        '    "required": true,',
        '    "source": "user.id",',
        '    "description": "Identifies the calling user."',
        "  }",
        "]",
      ].join("\n"),
    );
    assert.equal(
      contextContract,
      [
        "[",
        "  {",
        '    "key": "client_id",',
        '    "required": true,',
        '    "type": "string",',
        '    "description": "Selects the client partition.",',
        '    "example": "client-123"',
        "  }",
        "]",
      ].join("\n"),
    );
    for (const environmentKey of hostedEnvironmentKeys) {
      assert.match(
        html,
        new RegExp(
          `data-draft-publication-panel="${escapeRegExp(environmentKey)}"`,
        ),
      );
      assert.match(
        html,
        new RegExp(`name="publication:${escapeRegExp(environmentKey)}:enabled"`),
      );
      assert.match(
        html,
        new RegExp(`name="publication:${escapeRegExp(environmentKey)}:healthEndpointUrl"`),
      );
      assert.match(
        html,
        new RegExp(`name="publication:${escapeRegExp(environmentKey)}:invocationEndpoint"`),
      );
      assert.match(
        html,
        new RegExp(`name="publication:${escapeRegExp(environmentKey)}:rawCard"`),
      );
      assert.match(
        html,
        new RegExp(
          `<input class="draft-file-input" type="file" name="publication:${escapeRegExp(environmentKey)}:rawCard" \\/>`,
        ),
      );
    }
  } finally {
    await context.close();
  }
});

test("publisher console returns 403 for admin-only review and active agent detail routes", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const approvedFixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });

    await approvePendingVersion(context, approvedFixture);
    await seedHealthAndTelemetry(context.db, approvedFixture);
    await signIn(browser, "tenant-alpha", "publisher-alpha");

    // Act
    const reviewQueuePage = await browser.get("/tenants/tenant-alpha/review");
    const reviewQueueHtml = await reviewQueuePage.text();
    const versionDetailPage = await browser.get(
      `/tenants/tenant-alpha/agents/${approvedFixture.agentId}/versions/${approvedFixture.versionId}`,
    );
    const versionDetailHtml = await versionDetailPage.text();
    const agentDetailPage = await browser.get(`/tenants/tenant-alpha/agents/${approvedFixture.agentId}`);
    const agentDetailHtml = await agentDetailPage.text();

    // Assert
    assert.equal(reviewQueuePage.status, 403);
    assertUsesConsoleDocument(reviewQueueHtml);
    assert.match(reviewQueueHtml, /Tenant admin role is required/);
    assert.equal(versionDetailPage.status, 200);
    assert.doesNotMatch(versionDetailHtml, /Advisory Telemetry/);
    assert.doesNotMatch(versionDetailHtml, /Invocation count: 12/);
    assert.equal(agentDetailPage.status, 403);
    assert.match(agentDetailHtml, /Tenant admin role is required/);
  } finally {
    await context.close();
  }
});

test("publisher console returns 400 for malformed draft contract JSON", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    await signIn(browser, "tenant-alpha", "publisher-alpha");
    const draftForm = new FormData();

    draftForm.set("versionLabel", "v1");
    draftForm.set("displayName", "Case Resolver");
    draftForm.set("summary", "Handles support case routing.");
    draftForm.set("capabilities", "shared-capability, case-routing");
    draftForm.set("tags", "shared-tag, routing");
    draftForm.set("requiredRoles", "support-agent");
    draftForm.set("requiredScopes", "tickets.read");
    draftForm.set("headerContract", "{");
    draftForm.set(
      "contextContract",
      JSON.stringify([
        {
          description: "Selects the client partition.",
          example: "client-123",
          key: "client_id",
          required: true,
          type: "string",
        },
      ]),
    );
    draftForm.set("publication:dev:enabled", "on");
    draftForm.set("publication:dev:healthEndpointUrl", "https://dev.health.example.com/status");
    draftForm.set(
      "publication:dev:rawCard",
      new File(
        [
          createRawCard({
            capabilities: ["card-search", "dev-capability"],
            name: "Case Resolver",
            summary: "Handles support case routing.",
            tags: ["card-tag", "dev"],
          }),
        ],
        "dev-card.json",
        {
          type: "application/json",
        },
      ),
    );

    // Act
    const response = await browser.postForm("/tenants/tenant-alpha/drafts", draftForm);
    const html = await response.text();

    // Assert
    assert.equal(response.status, 400);
    assertUsesConsoleDocument(html);
    assert.match(html, /headerContract/);
    assert.match(html, /valid JSON/);
  } finally {
    await context.close();
  }
});

test("publisher console blocks version detail access to versions owned by another publisher", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const otherPublisherFixture = await createPendingVersion(context, {
      displayName: "Escalation Router",
      environments: ["dev"],
      publisherId: "publisher-bravo",
      summary: "Routes escalations for a different publisher.",
      versionLabel: "v2",
    });

    await signIn(browser, "tenant-alpha", "publisher-alpha");

    // Act
    const response = await browser.get(
      `/tenants/tenant-alpha/agents/${otherPublisherFixture.agentId}/versions/${otherPublisherFixture.versionId}`,
    );
    const html = await response.text();

    // Assert
    assert.equal(response.status, 403);
    assert.match(html, /versions they own/);
  } finally {
    await context.close();
  }
});

test("signed-in console renders shared document styling for 404 and 409 responses", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const fixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });

    await signIn(browser, "tenant-alpha", "admin-alpha");
    const initialApproveResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${fixture.agentId}/versions/${fixture.versionId}/approve`,
      {},
    );

    // Act
    const notFoundResponse = await browser.get("/missing-route");
    const notFoundHtml = await notFoundResponse.text();
    const conflictResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${fixture.agentId}/versions/${fixture.versionId}/approve`,
      {},
    );
    const conflictHtml = await conflictResponse.text();

    // Assert
    assert.equal(initialApproveResponse.status, 303);
    assert.equal(notFoundResponse.status, 404);
    assertUsesConsoleDocument(notFoundHtml);
    assert.match(notFoundHtml, /Route not found\./);
    assert.equal(conflictResponse.status, 409);
    assertUsesConsoleDocument(conflictHtml);
    assert.match(conflictHtml, /Only pending_review versions can be approved\./);
  } finally {
    await context.close();
  }
});

test("admin console approval enqueues initial publication probes", async () => {
  const enqueuedPublicationIds: string[] = [];
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
    reviewServiceOptions: {
      async enqueuePublicationProbe(publicationId) {
        enqueuedPublicationIds.push(publicationId);
      },
    },
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const fixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev", "prod"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });
    const publicationIds = (
      await context.db
        .selectFrom("environment_publications")
        .select("publication_id")
        .where("tenant_id", "=", "tenant-alpha")
        .where("agent_id", "=", fixture.agentId)
        .where("version_id", "=", fixture.versionId)
        .orderBy("environment_key")
        .execute()
    ).map((publication) => publication.publication_id);

    await signIn(browser, "tenant-alpha", "admin-alpha");

    // Act
    const response = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${fixture.agentId}/versions/${fixture.versionId}/approve`,
      {},
    );

    // Assert
    assert.equal(response.status, 303);
    assert.equal(getRedirectLocation(response), `/tenants/tenant-alpha/agents/${fixture.agentId}`);
    assert.deepEqual(enqueuedPublicationIds.sort(), publicationIds.sort());
  } finally {
    await context.close();
  }
});

test("admin environment management keeps the catalog primary and preserves creation flow", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    await signIn(browser, "tenant-alpha", "admin-alpha");
    const initialEnvironmentKeys = await listTenantEnvironmentKeys(context.db, "tenant-alpha");

    // Act
    const environmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const environmentsHtml = await environmentsPage.text();
    const createEnvironmentResponse = await browser.postUrlEncoded(
      "/tenants/tenant-alpha/environments",
      {
        environmentKey: "qa",
      },
    );
    const updatedEnvironmentKeys = await listTenantEnvironmentKeys(context.db, "tenant-alpha");
    const updatedEnvironmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const updatedEnvironmentsHtml = await updatedEnvironmentsPage.text();
    const initialCatalogSurface = extractEnvironmentCatalogSurface(environmentsHtml);
    const initialCatalogList = extractEnvironmentCatalogList(environmentsHtml);
    const creationPanel = extractEnvironmentCreationPanel(environmentsHtml);
    const updatedCatalogList = extractEnvironmentCatalogList(updatedEnvironmentsHtml);

    // Assert
    assert.equal(environmentsPage.status, 200);
    assertUsesConsoleDocument(environmentsHtml);
    assertShell(environmentsHtml, {
      currentNavHref: "/tenants/tenant-alpha/environments",
      page: "environments",
      shell: "authenticated",
    });
    assert.match(environmentsHtml, /Environment Management/);
    assert.match(environmentsHtml, /href="\/console"/);
    assert.match(environmentsHtml, /href="\/tenants\/tenant-alpha\/review"/);
    assert.match(environmentsHtml, /href="\/tenants\/tenant-alpha\/drafts\/new"/);
    assert.match(environmentsHtml, /href="#environment-creation-panel"/);
    assert.match(
      environmentsHtml,
      /<section class="environment-surfaces">\s*<div class="environment-catalog card stack">[\s\S]*?<aside class="environment-create card stack" id="environment-creation-panel">/,
    );
    assert.match(initialCatalogSurface, /<p class="console-kicker">Primary Surface<\/p>/);
    assert.match(initialCatalogSurface, /<h2>Environment Catalog<\/h2>/);
    assert.match(
      initialCatalogSurface,
      /Configured environments are the publish targets available across draft registration, review, and overlay workflows\./,
    );
    assert.equal((initialCatalogList.match(/<article class="environment-entry">/g) ?? []).length, 3);
    assert.match(initialCatalogList, /<h3>dev<\/h3>/);
    assert.match(initialCatalogList, /<h3>prod<\/h3>/);
    assert.match(initialCatalogList, /<h3>staging<\/h3>/);
    assert.doesNotMatch(initialCatalogList, /<h3>qa<\/h3>/);
    assert.match(creationPanel, /<p class="console-kicker">Secondary Panel<\/p>/);
    assert.match(creationPanel, /<h2>Create Environment<\/h2>/);
    assert.match(creationPanel, /action="\/tenants\/tenant-alpha\/environments"/);
    assert.match(creationPanel, /name="environmentKey"/);
    assert.deepEqual(initialEnvironmentKeys, ["dev", "prod", "staging"]);
    assert.doesNotMatch(environmentsHtml, /Export Config \(JSON\)/);
    assert.doesNotMatch(environmentsHtml, /Global Logs/);
    assert.equal(createEnvironmentResponse.status, 303);
    assert.equal(getRedirectLocation(createEnvironmentResponse), "/tenants/tenant-alpha/environments");
    assert.equal(updatedEnvironmentsPage.status, 200);
    assert.deepEqual(updatedEnvironmentKeys, ["dev", "prod", "qa", "staging"]);
    assert.equal((updatedCatalogList.match(/<article class="environment-entry">/g) ?? []).length, 4);
    assert.match(updatedCatalogList, /<h3>qa<\/h3>/);
  } finally {
    await context.close();
  }
});

test("admin console manages environments, reviews pending versions, edits overlays, and inspects details", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const approveFixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev", "prod"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });
    const rejectFixture = await createPendingVersion(context, {
      displayName: "Case Escalator",
      environments: ["dev"],
      publisherId: "publisher-alpha",
      summary: "Escalates complex cases.",
      versionLabel: "v2",
    });

    await signIn(browser, "tenant-alpha", "admin-alpha");

    const dashboardPage = await browser.get("/console");
    const dashboardHtml = await dashboardPage.text();
    const environmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const environmentsHtml = await environmentsPage.text();

    // Act
    const createEnvironmentResponse = await browser.postUrlEncoded("/tenants/tenant-alpha/environments", {
      environmentKey: "qa",
    });
    const updatedEnvironmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const updatedEnvironmentsHtml = await updatedEnvironmentsPage.text();
    const reviewQueuePage = await browser.get("/tenants/tenant-alpha/review");
    const reviewQueueHtml = await reviewQueuePage.text();
    const approveResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}/approve`,
      {},
    );

    await seedHealthAndTelemetry(context.db, approveFixture);

    const approvedVersionPage = await browser.get(
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}`,
    );
    const approvedVersionHtml = await approvedVersionPage.text();
    const deprecateEnvironmentResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}/environments/prod/overlay/deprecate`,
      {},
    );
    const agentDetailPage = await browser.get(`/tenants/tenant-alpha/agents/${approveFixture.agentId}`);
    const agentDetailHtml = await agentDetailPage.text();
    const rejectResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}/reject`,
      {
        reason: "Needs clearer scopes.",
      },
    );
    const rejectedVersionPage = await browser.get(
      `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}`,
    );
    const rejectedVersionHtml = await rejectedVersionPage.text();
    const overlayRows = await new KyselyAgentAdminDetailRepository(context.db).getAgentDetail(
      "tenant-alpha",
      approveFixture.agentId,
    );

    // Assert
    assertShell(dashboardHtml, {
      currentNavHref: "/console",
      page: "dashboard",
      shell: "authenticated",
    });
    assert.match(dashboardHtml, /Environment Management/);
    assert.match(dashboardHtml, /Review Queue/);
    assert.equal(environmentsPage.status, 200);
    assertShell(environmentsHtml, {
      currentNavHref: "/tenants/tenant-alpha/environments",
      page: "environments",
      shell: "authenticated",
    });
    assert.doesNotMatch(extractEnvironmentCatalogList(environmentsHtml), /<h3>qa<\/h3>/);
    assert.equal(createEnvironmentResponse.status, 303);
    assert.equal(getRedirectLocation(createEnvironmentResponse), "/tenants/tenant-alpha/environments");
    assert.match(extractEnvironmentCatalogList(updatedEnvironmentsHtml), /<h3>qa<\/h3>/);
    assertShell(reviewQueueHtml, {
      currentNavHref: "/tenants/tenant-alpha/review",
      page: "review-queue",
      shell: "authenticated",
    });
    assert.equal((reviewQueueHtml.match(/data-review-entry="/g) ?? []).length, 2);
    assertReviewQueueEntry(reviewQueueHtml, {
      displayName: "Case Router",
      fixture: approveFixture,
      tenantId: "tenant-alpha",
    });
    assertReviewQueueEntry(reviewQueueHtml, {
      displayName: "Case Escalator",
      fixture: rejectFixture,
      tenantId: "tenant-alpha",
    });
    assert.match(reviewQueueHtml, /Submitted for review/);
    assertReviewQueueOmitsUnsupportedControls(reviewQueueHtml, 2);
    assert.equal(approveResponse.status, 303);
    assert.equal(getRedirectLocation(approveResponse), `/tenants/tenant-alpha/agents/${approveFixture.agentId}`);
    assertShell(approvedVersionHtml, {
      currentNavHref: `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}`,
      page: "version-detail",
      shell: "authenticated",
    });
    assert.match(approvedVersionHtml, /Health History/);
    assert.match(approvedVersionHtml, /503/);
    assert.match(approvedVersionHtml, /Invocation count: 12/);
    assert.match(approvedVersionHtml, /p95 latency: 280/);
    assert.equal(deprecateEnvironmentResponse.status, 303);
    assert.equal(
      getRedirectLocation(deprecateEnvironmentResponse),
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}`,
    );
    assertShell(agentDetailHtml, {
      currentNavHref: `/tenants/tenant-alpha/agents/${approveFixture.agentId}`,
      page: "agent-detail",
      shell: "authenticated",
    });
    assert.match(agentDetailHtml, /Overlay State/);
    assert.match(agentDetailHtml, /Environment overlay for prod/);
    assert.match(agentDetailHtml, /Deprecated: yes/);
    assert.deepEqual(
      overlayRows.overlay.environments.find((overlay) => overlay.environmentKey === "prod"),
      {
        deprecated: true,
        disabled: false,
        environmentKey: "prod",
        requiredRoles: [],
        requiredScopes: [],
      },
    );
    assert.equal(rejectResponse.status, 303);
    assert.equal(
      getRedirectLocation(rejectResponse),
      `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}`,
    );
    assertShell(rejectedVersionHtml, {
      currentNavHref: `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}`,
      page: "version-detail",
      shell: "authenticated",
    });
    assert.match(rejectedVersionHtml, /Approval state: rejected/);
    assert.match(rejectedVersionHtml, /Rejected reason: Needs clearer scopes\./);
  } finally {
    await context.close();
  }
});

test("self-hosted console collapses tenant selection while keeping tenant-scoped routes", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "self-hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const signInPage = await browser.get("/");
    const signInHtml = await signInPage.text();

    // Act
    await signIn(browser, "tenant-self-hosted", "admin-self-hosted");

    const dashboardPage = await browser.get("/console");
    const dashboardHtml = await dashboardPage.text();

    // Assert
    assert.equal(signInPage.status, 200);
    assertPublicLandingLayout(signInHtml);
    assert.doesNotMatch(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(signInHtml, /type="hidden"[^>]+name="tenantId"[^>]+tenant-self-hosted/);
    assert.match(signInHtml, /Single-tenant deployment/);
    assertShell(dashboardHtml, {
      currentNavHref: "/console",
      page: "dashboard",
      shell: "authenticated",
    });
    assert.match(dashboardHtml, /\/tenants\/tenant-self-hosted\/environments/);
    assert.match(dashboardHtml, /Tenant Self Hosted/);
  } finally {
    await context.close();
  }
});
