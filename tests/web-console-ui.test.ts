import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

interface WebConsoleContext extends FreshRegistryDatabase {
  baseUrl: string;
  close(): Promise<void>;
  config: RegistryConfig;
}

interface PendingVersionFixture {
  agentId: string;
  displayName: string;
  publisherId: string;
  submittedAt: string;
  versionId: string;
  versionLabel: string;
  versionSequence: number;
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

async function createWebConsoleContext(options: {
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
      options.deploymentMode === "self-hosted"
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
          ].join("\n");

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

function createMembershipRow(
  overrides: Partial<{
    registry_capabilities: string[];
    roles: string[];
    scopes: string[];
    subject_id: string;
    tenant_id: string;
    user_context: Record<string, unknown>;
  }> = {},
) {
  return {
    registry_capabilities: [],
    roles: ["publisher"],
    scopes: [],
    subject_id: "publisher-alpha",
    tenant_id: "tenant-alpha",
    user_context: {},
    ...overrides,
  };
}

function createSelectRowsBuilder<TResult>(rows: TResult[]) {
  return {
    select() {
      return this;
    },
    where() {
      return this;
    },
    orderBy() {
      return this;
    },
    forUpdate() {
      return this;
    },
    async execute() {
      return rows;
    },
    async executeTakeFirst() {
      return rows[0];
    },
  };
}

function createSelectBuilder<TResult>(result: TResult | undefined) {
  return createSelectRowsBuilder(result === undefined ? [] : [result]);
}

function createSessionStubDb(
  membershipRow = createMembershipRow(),
): AgentRegistryDb {
  return {
    selectFrom(table: string) {
      if (table !== "tenant_memberships") {
        throw new Error(`Unexpected table '${table}'`);
      }

      return createSelectBuilder(membershipRow);
    },
  } as unknown as AgentRegistryDb;
}

function createEmptyConsoleDb(): AgentRegistryDb {
  return {
    selectFrom(table: string) {
      if (table !== "tenants" && table !== "tenant_memberships") {
        throw new Error(`Unexpected table '${table}'`);
      }

      return createSelectBuilder(undefined);
    },
  } as unknown as AgentRegistryDb;
}

function createPartialBootstrapConsoleDb(): AgentRegistryDb {
  return {
    selectFrom(table: string) {
      if (table === "tenants") {
        return createSelectRowsBuilder([
          {
            display_name: "Tenant Alpha",
            tenant_id: "tenant-alpha",
          },
        ]);
      }

      if (table === "tenant_memberships") {
        return createSelectRowsBuilder([]);
      }

      throw new Error(`Unexpected table '${table}'`);
    },
  } as unknown as AgentRegistryDb;
}

function createVersionTransitionStubDb(): AgentRegistryDb {
  return {
    selectFrom(table: string) {
      if (table !== "tenant_memberships") {
        throw new Error(`Unexpected table '${table}'`);
      }

      return createSelectBuilder(createMembershipRow());
    },
    transaction() {
      return {
        execute: async (callback: (transaction: unknown) => Promise<unknown>) =>
          callback({
            selectFrom(table: string) {
              if (table !== "agent_versions") {
                throw new Error(`Unexpected transaction table '${table}'`);
              }

              return createSelectBuilder({
                approval_state: "pending_review",
                version_id: "version-stub",
              });
            },
          }),
      };
    },
  } as unknown as AgentRegistryDb;
}

function assertRenderedDocumentUsesSharedAssets(html: string): void {
  assert.match(html, /<link[^>]+rel="preload"[^>]+href="\/assets\/fonts\/manrope-latin-variable\.woff2"/);
  assert.match(html, /<link[^>]+rel="preload"[^>]+href="\/assets\/fonts\/inter-latin-variable\.woff2"/);
  assert.match(html, /<link[^>]+rel="stylesheet"[^>]+href="\/assets\/console\.css"/);
}

function assertHasDataHook(html: string, attribute: string, value: string): void {
  assert.match(html, new RegExp(`${attribute}="${value}"`));
}

function extractBalancedElementMarkup(
  html: string,
  options: {
    startIndex: number;
    tagName: string;
  },
): string {
  const tagPattern = new RegExp(
    `<${options.tagName}\\b[^>]*>|</${options.tagName}>`,
    "g",
  );

  tagPattern.lastIndex = options.startIndex;

  let depth = 0;

  for (let match = tagPattern.exec(html); match !== null; match = tagPattern.exec(html)) {
    if (match[0].startsWith(`</${options.tagName}`)) {
      depth -= 1;
    } else {
      depth += 1;
    }

    if (depth === 0) {
      return html.slice(options.startIndex, tagPattern.lastIndex);
    }
  }

  throw new Error(`Expected balanced <${options.tagName}> markup starting at index ${options.startIndex}`);
}

function getElementMarkupByDataHook(
  html: string,
  options: {
    attribute: string;
    tagName: string;
    value: string;
  },
): string {
  const openingTagPattern = new RegExp(
    `<${options.tagName}\\b[^>]*${options.attribute}="${escapeRegExp(options.value)}"[^>]*>`,
  );
  const openingTagMatch = openingTagPattern.exec(html);

  assert.notEqual(
    openingTagMatch,
    null,
    `Expected <${options.tagName}> with ${options.attribute}="${options.value}"`,
  );

  return extractBalancedElementMarkup(html, {
    startIndex: openingTagMatch.index,
    tagName: options.tagName,
  });
}

function assertMarkupContainsField(markup: string, fieldName: string): void {
  assert.match(markup, new RegExp(`name="${escapeRegExp(fieldName)}"`));
}

function assertMarkupDoesNotContainField(markup: string, fieldName: string): void {
  assert.doesNotMatch(markup, new RegExp(`name="${escapeRegExp(fieldName)}"`));
}

function assertDraftRegistrationFormContract(
  html: string,
  options: {
    environmentKeys: string[];
    expectSubmitDisabled?: boolean;
    tenantId: string;
  },
): void {
  assert.match(
    html,
    new RegExp(
      `<form[^>]+action="/tenants/${escapeRegExp(options.tenantId)}/drafts"[^>]+method="post"[^>]+enctype="multipart/form-data"`,
    ),
  );

  const metadataRegion = getElementMarkupByDataHook(html, {
    attribute: "data-form-region",
    tagName: "section",
    value: "metadata",
  });
  const contractsRegion = getElementMarkupByDataHook(html, {
    attribute: "data-form-region",
    tagName: "section",
    value: "contracts",
  });
  const publicationsRegion = getElementMarkupByDataHook(html, {
    attribute: "data-form-region",
    tagName: "section",
    value: "publications",
  });
  const actionsRegion = getElementMarkupByDataHook(html, {
    attribute: "data-form-region",
    tagName: "section",
    value: "actions",
  });

  assert.match(metadataRegion, /General Metadata/);
  assert.match(contractsRegion, /Shared Contracts/);
  assert.match(publicationsRegion, /Environment Publications/);
  assert.match(actionsRegion, /Draft Actions/);

  for (const fieldName of [
    "versionLabel",
    "displayName",
    "summary",
    "capabilities",
    "tags",
    "requiredRoles",
    "requiredScopes",
  ]) {
    assertMarkupContainsField(metadataRegion, fieldName);
  }

  for (const fieldName of ["headerContract", "contextContract"]) {
    assertMarkupContainsField(contractsRegion, fieldName);
  }

  assertMarkupDoesNotContainField(metadataRegion, "headerContract");
  assertMarkupDoesNotContainField(metadataRegion, "contextContract");
  assertMarkupDoesNotContainField(contractsRegion, "versionLabel");
  assertMarkupDoesNotContainField(contractsRegion, "displayName");

  assertMarkupDoesNotContainField(publicationsRegion, "versionLabel");
  assertMarkupDoesNotContainField(publicationsRegion, "headerContract");

  for (const environmentKey of options.environmentKeys) {
    const publicationPanel = getElementMarkupByDataHook(publicationsRegion, {
      attribute: "data-publication-environment",
      tagName: "section",
      value: environmentKey,
    });

    assert.match(publicationPanel, new RegExp(`>${escapeRegExp(environmentKey)}<`));

    for (const suffix of [
      "enabled",
      "healthEndpointUrl",
      "invocationEndpoint",
      "rawCard",
    ]) {
      assertMarkupContainsField(
        publicationPanel,
        `publication:${environmentKey}:${suffix}`,
      );
    }

    for (const otherEnvironmentKey of options.environmentKeys) {
      if (otherEnvironmentKey === environmentKey) {
        continue;
      }

      assert.doesNotMatch(
        publicationPanel,
        new RegExp(`name="${escapeRegExp(`publication:${otherEnvironmentKey}:`)}`),
      );
    }
  }

  if (options.environmentKeys.length === 0) {
    assert.match(publicationsRegion, /No environments are configured yet for this tenant\./);
    assert.match(publicationsRegion, /At least one configured environment is required before a draft can be created\./);
    assert.doesNotMatch(publicationsRegion, /data-publication-environment="/);
    assert.doesNotMatch(publicationsRegion, /name="publication:/);
  }

  if (options.expectSubmitDisabled) {
    assert.match(actionsRegion, /<button[^>]+type="submit"[^>]+disabled[^>]*>Create Draft<\/button>/);
    return;
  }

  assert.match(actionsRegion, /<button[^>]+type="submit"[^>]*>Create Draft<\/button>/);
  assert.doesNotMatch(actionsRegion, /name="versionLabel"/);
  assert.doesNotMatch(actionsRegion, /name="headerContract"/);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getNavMarkup(html: string, variant: "mobile" | "rail"): string {
  const navMatch = html.match(
    new RegExp(`<nav[^>]+data-nav="${variant}"[^>]*>[\\s\\S]*?<\\/nav>`),
  );

  assert.notEqual(navMatch, null, `Expected ${variant} nav markup to be rendered`);

  return navMatch[0];
}

function getVisualDynamicSectionMarkup(html: string, hook: string): string {
  const sectionMatch = html.match(
    new RegExp(
      `<section[^>]+data-visual-dynamic="${escapeRegExp(hook)}"[^>]*>[\\s\\S]*?<\\/section>`,
    ),
  );

  assert.notEqual(sectionMatch, null, `Expected ${hook} section markup to be rendered`);

  return sectionMatch[0];
}

function assertPublicationDossierMarkup(
  html: string,
  expectedDossiers: Array<{
    environmentKey: string;
    rawCardValue: string;
  }>,
): void {
  const publicationDetailMarkup = getVisualDynamicSectionMarkup(html, "publication-detail-list");
  const publicationArticles = Array.from(
    publicationDetailMarkup.matchAll(
      /<article class="version-detail-publication-card stack">[\s\S]*?<\/article>/g,
    ),
    (match) => match[0],
  );

  assert.notEqual(publicationArticles.length, 0, "Expected publication dossier articles to be rendered");

  for (const dossier of expectedDossiers) {
    const matchingArticles = publicationArticles.filter((articleMarkup) =>
      new RegExp(
        `<span class="shell-eyebrow">Environment: ${escapeRegExp(dossier.environmentKey)}<\\/span>`,
      ).test(articleMarkup),
    );

    assert.equal(
      matchingArticles.length,
      1,
      `Expected exactly one ${dossier.environmentKey} publication dossier article to be rendered`,
    );

    const [publicationMarkup] = matchingArticles;

    assert.match(publicationMarkup, /Normalized Metadata/);
    assert.match(publicationMarkup, /Raw Card/);
    assert.match(
      publicationMarkup,
      new RegExp(`<span class="shell-eyebrow">Raw Card<\\/span>[\\s\\S]*?${escapeRegExp(dossier.rawCardValue)}`),
    );
  }
}

function getEnvironmentPanelMarkup(html: string, panel: "inventory" | "creation"): string {
  const panelMatch = new RegExp(
    `<(?<tagName>section|aside)\\b[^>]+data-environment-panel="${panel}"[^>]*>`,
  ).exec(html);

  assert.notEqual(panelMatch, null, `Expected ${panel} panel markup to be rendered`);

  return extractBalancedElementMarkup(html, {
    startIndex: panelMatch.index,
    tagName: panelMatch.groups?.tagName ?? "section",
  });
}

function getFirstFormMarkup(markup: string): string {
  const formMatch = /<form\b[^>]*>/.exec(markup);

  assert.notEqual(formMatch, null, "Expected form markup to be rendered");

  return extractBalancedElementMarkup(markup, {
    startIndex: formMatch.index,
    tagName: "form",
  });
}

function getFormAction(markup: string): string {
  const actionMatch = markup.match(/\saction="([^"]+)"/);

  assert.notEqual(actionMatch, null, "Expected rendered form action to be present");

  return actionMatch[1];
}

function countMatches(input: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;

  return Array.from(input.matchAll(new RegExp(pattern.source, flags))).length;
}

function getDashboardCardMarkup(html: string, cardClass: string): string {
  const cardMatch = html.match(
    new RegExp(`<article[^>]+${escapeRegExp(cardClass)}[^>]*>[\\s\\S]*?<\\/article>`),
  );

  assert.notEqual(cardMatch, null, `Expected dashboard card '${cardClass}' to be rendered`);

  return cardMatch[0];
}

function listDashboardCardClasses(html: string): string[] {
  const dashboardCards = Array.from(
    html.matchAll(/<article[^>]+class="([^"]*\bdashboard-card\b[^"]*)"[^>]*>/g),
    (match) => match[1],
  );

  return dashboardCards
    .map((classNames) =>
      classNames
        .split(/\s+/)
        .find((className) => className.startsWith("dashboard-card--")),
    )
    .filter((className): className is string => className !== undefined)
    .sort();
}

function listMarkupHrefs(markup: string): string[] {
  return Array.from(markup.matchAll(/href="([^"]+)"/g), (match) => match[1]).sort();
}

function assertMarkupContainsLinkWithStrongLabel(
  markup: string,
  link: {
    href: string;
    label: string;
  },
): void {
  assert.match(
    markup,
    new RegExp(
      `<a[^>]+href="${escapeRegExp(link.href)}"[^>]*>[\\s\\S]*?<strong>${escapeRegExp(link.label)}<\\/strong>[\\s\\S]*?<\\/a>`,
    ),
  );
}

function assertMarkupContainsLink(
  markup: string,
  link: {
    href: string;
    label: string;
  },
): void {
  assert.match(
    markup,
    new RegExp(
      `<a[^>]+href="${escapeRegExp(link.href)}"[^>]*>[\\s\\S]*?${escapeRegExp(link.label)}[\\s\\S]*?<\\/a>`,
    ),
  );
}

function assertNavContainsLink(
  navMarkup: string,
  link: {
    href: string;
    label: string;
  },
): void {
  assert.match(
    navMarkup,
    new RegExp(
      `<a[^>]+href="${escapeRegExp(link.href)}"[^>]*>${escapeRegExp(link.label)}<\\/a>`,
    ),
  );
}

function assertNavDoesNotContainLink(
  navMarkup: string,
  link: {
    href: string;
    label: string;
  },
): void {
  assert.doesNotMatch(
    navMarkup,
    new RegExp(
      `<a[^>]+href="${escapeRegExp(link.href)}"[^>]*>${escapeRegExp(link.label)}<\\/a>`,
    ),
  );
}

function assertDocumentContainsHref(html: string, href: string): void {
  assert.match(html, new RegExp(`href="${escapeRegExp(href)}"`));
}

function assertDocumentDoesNotContainHref(html: string, href: string): void {
  assert.doesNotMatch(html, new RegExp(`href="${escapeRegExp(href)}"`));
}

function assertAuthenticatedShellContract(
  html: string,
  options: {
    dynamicHooks: string[];
    navExcludes?: Array<{
      href: string;
      label: string;
    }>;
    navLinks: Array<{
      href: string;
      label: string;
    }>;
    page: string;
  },
): void {
  assertHasDataHook(html, "data-page", options.page);
  assertHasDataHook(html, "data-shell", "authenticated");
  assertHasDataHook(html, "data-visual-dynamic", "session-context");

  for (const variant of ["rail", "mobile"] as const) {
    assertHasDataHook(html, "data-nav", variant);

    const navMarkup = getNavMarkup(html, variant);

    for (const link of options.navLinks) {
      assertNavContainsLink(navMarkup, link);
    }

    for (const link of options.navExcludes ?? []) {
      assertNavDoesNotContainLink(navMarkup, link);
    }
  }

  for (const hook of options.dynamicHooks) {
    assertHasDataHook(html, "data-visual-dynamic", hook);
  }
}

function assertEnvironmentManagementPage(
  html: string,
  options: {
    expectedEnvironmentKeys?: string[];
    navLinks: Array<{
      href: string;
      label: string;
    }>;
    state: "empty" | "populated";
    tenantId: string;
    unexpectedEnvironmentKeys?: string[];
  },
): void {
  assertAuthenticatedShellContract(html, {
    dynamicHooks: ["environment-list"],
    navLinks: options.navLinks,
    page: "tenant-environments",
  });
  const inventoryPanel = getEnvironmentPanelMarkup(html, "inventory");
  const creationPanel = getEnvironmentPanelMarkup(html, "creation");
  const creationForm = getFirstFormMarkup(creationPanel);
  const inventoryPanelIndex = html.indexOf('data-environment-panel="inventory"');
  const creationPanelIndex = html.indexOf('data-environment-panel="creation"');
  const createEnvironmentFormPattern = new RegExp(
    `<form[^>]+action="/tenants/${escapeRegExp(options.tenantId)}\\/environments"[^>]+method="post"`,
  );

  assertHasDataHook(html, "data-environment-layout", "management");
  assertHasDataHook(html, "data-environment-state", options.state);
  assert.ok(
    inventoryPanelIndex >= 0 && creationPanelIndex >= 0 && inventoryPanelIndex < creationPanelIndex,
    "Expected configured inventory to precede the secondary creation panel",
  );
  assert.match(inventoryPanel, /Configured Environments/);
  assert.match(inventoryPanel, /class="environment-list"/);
  assert.match(creationPanel, /Add Environment/);
  assert.match(creationForm, /class="environment-form"/);
  assert.match(creationForm, createEnvironmentFormPattern);
  assert.match(creationForm, /<input[^>]+name="environmentKey"/);
  assert.match(creationForm, /<button[^>]*type="submit"[^>]*>Add Environment<\/button>/);
  assert.doesNotMatch(
    creationForm,
    /<button[^>]*type="submit"[^>]*disabled[^>]*>Add Environment<\/button>/,
  );
  assert.doesNotMatch(inventoryPanel, createEnvironmentFormPattern);
  assert.doesNotMatch(inventoryPanel, /<input[^>]+name="environmentKey"/);
  assert.doesNotMatch(creationPanel, /<article[^>]+class="environment-entry"/);
  assert.doesNotMatch(html, /Active Clusters|Avg Uptime|Registry Load|Instances|Region|Last Deploy/);
  assert.doesNotMatch(html, /Export Config \(JSON\)|Global Logs|more_vert/);

  if (options.state === "empty") {
    assert.match(inventoryPanel, /No environments have been configured yet\./);
    assert.doesNotMatch(inventoryPanel, /<article[^>]+class="environment-entry"/);

    for (const environmentKey of options.unexpectedEnvironmentKeys ?? []) {
      assert.doesNotMatch(
        inventoryPanel,
        new RegExp(`<h3>${escapeRegExp(environmentKey)}<\\/h3>`),
      );
    }
  } else {
    assert.match(inventoryPanel, /<article[^>]+class="environment-entry"/);

    for (const environmentKey of options.expectedEnvironmentKeys ?? []) {
      assert.match(inventoryPanel, new RegExp(`<h3>${escapeRegExp(environmentKey)}<\\/h3>`));
    }
  }
}

function assertDashboardContract(
  html: string,
  options: {
    actionLinks: Array<{
      href: string;
      label: string;
    }>;
    activeAgentEmptyState?: string;
    activeAgentLinks?: Array<{
      href: string;
      label: string;
    }>;
    hiddenActionHrefs?: string[];
    identityPanel?: {
      access: string;
      roleLabel: string;
      subjectId: string;
      tenantId: string;
    };
    hiddenVersionLabels?: string[];
    includeActiveAgents: boolean;
    metrics: Array<{
      label: string;
      value: string;
    }>;
    versionEmptyState?: string;
    versionLinks?: Array<{
      href: string;
      label: string;
    }>;
  },
): void {
  assertHasDataHook(html, "data-dashboard-layout", "bento");
  assertHasDataHook(html, "data-visual-dynamic", "dashboard-identity");
  assertHasDataHook(html, "data-visual-dynamic", "dashboard-actions");
  assertHasDataHook(html, "data-visual-dynamic", "dashboard-versions");
  const expectedDashboardCards = [
    "dashboard-card--actions",
    "dashboard-card--hero",
    "dashboard-card--identity",
    "dashboard-card--tenant",
    "dashboard-card--versions",
    ...(options.includeActiveAgents ? ["dashboard-card--active-agents"] : []),
  ].sort();

  assert.deepEqual(listDashboardCardClasses(html), expectedDashboardCards);
  assert.equal(
    countMatches(html, /class="[^"]*\bdashboard-card\b[^"]*"/),
    expectedDashboardCards.length,
  );

  const [primaryActionLink] = options.actionLinks;
  const heroMarkup = getDashboardCardMarkup(html, "dashboard-card--hero");
  const actionsMarkup = getDashboardCardMarkup(html, "dashboard-card--actions");
  const versionsMarkup = getDashboardCardMarkup(html, "dashboard-card--versions");

  assertHasDataHook(heroMarkup, "data-dashboard-panel", "primary-feature");
  assertHasDataHook(actionsMarkup, "data-dashboard-panel", "supporting-actions");
  assertHasDataHook(versionsMarkup, "data-dashboard-panel", "version-register");
  assert.match(html, /Signed-In Identity/);
  assert.match(html, /Tenant Context/);
  assert.match(actionsMarkup, /Workspace Actions/);
  assert.match(versionsMarkup, /Visible Versions/);
  assert.equal(
    countMatches(heroMarkup, /<div class="dashboard-metric">/),
    options.metrics.length,
  );

  for (const metric of options.metrics) {
    assert.match(
      heroMarkup,
      new RegExp(
        `<div class="dashboard-metric">[\\s\\S]*?<span class="shell-eyebrow">${escapeRegExp(metric.label)}<\\/span>[\\s\\S]*?<strong>${escapeRegExp(metric.value)}<\\/strong>[\\s\\S]*?<\\/div>`,
      ),
    );
  }

  assert.notEqual(primaryActionLink, undefined, "Expected a primary dashboard action link");
  assert.match(heroMarkup, /class="[^"]*dashboard-feature__cta[^"]*"/);
  assertMarkupContainsLink(heroMarkup, primaryActionLink);

  if (options.identityPanel !== undefined) {
    const identityMarkup = getDashboardCardMarkup(html, "dashboard-card--identity");

    assertHasDataHook(identityMarkup, "data-dashboard-panel", "identity");
    assertHasDataHook(identityMarkup, "data-visual-dynamic", "dashboard-identity");
    assert.match(
      identityMarkup,
      new RegExp(`<h2>${escapeRegExp(options.identityPanel.subjectId)}<\\/h2>`),
    );
    assert.match(
      identityMarkup,
      new RegExp(`<p class="meta">${escapeRegExp(options.identityPanel.roleLabel)}<\\/p>`),
    );
    assert.match(
      identityMarkup,
      new RegExp(
        `<dt>Tenant<\\/dt>[\\s\\S]*?<dd>${escapeRegExp(options.identityPanel.tenantId)}<\\/dd>`,
      ),
    );
    assert.match(
      identityMarkup,
      new RegExp(
        `<dt>Access<\\/dt>[\\s\\S]*?<dd>${escapeRegExp(options.identityPanel.access)}<\\/dd>`,
      ),
    );
  }

  assert.deepEqual(
    listMarkupHrefs(actionsMarkup),
    options.actionLinks.map((link) => link.href).sort(),
  );
  assert.equal(
    countMatches(actionsMarkup, /class="dashboard-action(?:\s|")/),
    options.actionLinks.length,
  );

  for (const link of options.actionLinks) {
    assertMarkupContainsLinkWithStrongLabel(actionsMarkup, link);
  }

  if (options.includeActiveAgents) {
    assertHasDataHook(html, "data-visual-dynamic", "dashboard-active-agents");
    const activeAgentsMarkup = getDashboardCardMarkup(html, "dashboard-card--active-agents");
    const activeAgentLinks = options.activeAgentLinks ?? [];

    assertHasDataHook(activeAgentsMarkup, "data-dashboard-panel", "active-agents");
    assert.match(activeAgentsMarkup, /Active Agents/);
    assert.deepEqual(
      listMarkupHrefs(activeAgentsMarkup),
      activeAgentLinks.map((link) => link.href).sort(),
    );
    assert.equal(
      countMatches(activeAgentsMarkup, /class="dashboard-record"/),
      activeAgentLinks.length,
    );

    for (const link of activeAgentLinks) {
      assertMarkupContainsLinkWithStrongLabel(activeAgentsMarkup, link);
    }

    if (activeAgentLinks.length === 0) {
      assert.match(
        activeAgentsMarkup,
        new RegExp(escapeRegExp(options.activeAgentEmptyState ?? "")),
      );
    } else if (options.activeAgentEmptyState !== undefined) {
      assert.doesNotMatch(
        activeAgentsMarkup,
        new RegExp(escapeRegExp(options.activeAgentEmptyState)),
      );
    }
  } else {
    assert.doesNotMatch(html, /data-visual-dynamic="dashboard-active-agents"/);
    assert.doesNotMatch(html, /Active Agents/);
  }

  for (const href of options.hiddenActionHrefs ?? []) {
    assertDocumentDoesNotContainHref(actionsMarkup, href);
  }

  const versionLinks = options.versionLinks ?? [];

  assert.deepEqual(
    listMarkupHrefs(versionsMarkup),
    versionLinks.map((link) => link.href).sort(),
  );
  assert.equal(
    countMatches(versionsMarkup, /class="dashboard-record"/),
    versionLinks.length,
  );

  for (const link of versionLinks) {
    assertMarkupContainsLinkWithStrongLabel(versionsMarkup, link);
  }

  for (const label of options.hiddenVersionLabels ?? []) {
    assert.doesNotMatch(versionsMarkup, new RegExp(escapeRegExp(label)));
  }

  if (versionLinks.length === 0) {
    assert.match(versionsMarkup, new RegExp(escapeRegExp(options.versionEmptyState ?? "")));
  } else if (options.versionEmptyState !== undefined) {
    assert.doesNotMatch(versionsMarkup, new RegExp(escapeRegExp(options.versionEmptyState)));
  }

  assert.doesNotMatch(actionsMarkup, /href="#"/);
}

function assertPublicSignInShellContract(html: string): void {
  assertHasDataHook(html, "data-page", "sign-in");
  assertHasDataHook(html, "data-shell", "public");
  assertHasDataHook(html, "data-visual-dynamic", "sign-in-hero");
  assertHasDataHook(html, "data-visual-dynamic", "sign-in-access");
  assertHasDataHook(html, "data-visual-dynamic", "sign-in-companion");
  assert.match(
    html,
    /<header class="public-topbar">[\s\S]*?<div class="public-topbar__actions">[\s\S]*?href="#sign-in-access"[\s\S]*?href="\/console"[\s\S]*?<\/header>/,
  );
  assert.match(
    html,
    /<footer class="public-footer">[\s\S]*?Architectural Precision[\s\S]*?href="#sign-in-access"[\s\S]*?href="#sign-in-companion"[\s\S]*?href="\/console"[\s\S]*?<\/footer>/,
  );
  assert.doesNotMatch(html, /data-nav="/);
  assert.doesNotMatch(html, /class="shell-topbar"/);
  assert.doesNotMatch(html, /class="shell-frame"/);
  assertRenderedDocumentUsesSharedAssets(html);
}

function getRedirectLocation(response: Response): string {
  const location = response.headers.get("location");

  if (location === null) {
    throw new Error(`Expected redirect location but received status ${response.status}`);
  }

  return location;
}

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

  const persistedVersion = await context.db
    .selectFrom("agent_versions")
    .select(["display_name", "publisher_id", "submitted_at", "version_label", "version_sequence"])
    .where("tenant_id", "=", "tenant-alpha")
    .where("agent_id", "=", draft.agentId)
    .where("version_id", "=", draft.versionId)
    .executeTakeFirstOrThrow();

  if (persistedVersion.submitted_at === null) {
    throw new Error("Expected submitted review version to have a submission timestamp.");
  }

  return {
    agentId: draft.agentId,
    displayName: persistedVersion.display_name,
    publisherId: persistedVersion.publisher_id,
    submittedAt: String(persistedVersion.submitted_at),
    versionId: draft.versionId,
    versionLabel: persistedVersion.version_label,
    versionSequence: persistedVersion.version_sequence,
  };
}

function assertReviewQueueEntry(
  html: string,
  fixture: PendingVersionFixture,
): void {
  const versionDetailPath = `/tenants/tenant-alpha/agents/${fixture.agentId}/versions/${fixture.versionId}`;
  const approvePath = `${versionDetailPath}/approve`;
  const rejectPath = `${versionDetailPath}/reject`;
  const postFormPattern = (action: string): string =>
    `<form[^>]*(?:action="${escapeRegExp(action)}"[^>]*method="post"|method="post"[^>]*action="${escapeRegExp(action)}")[^>]*>`;

  assert.match(
    html,
    new RegExp(
      [
        "<li[^>]+>",
        `[\\s\\S]*${escapeRegExp(fixture.displayName)}`,
        `[\\s\\S]*${escapeRegExp(fixture.versionLabel)}`,
        `[\\s\\S]*${escapeRegExp(fixture.publisherId)}`,
        `[\\s\\S]*Submitted`,
        `[\\s\\S]*${escapeRegExp(fixture.submittedAt)}`,
        `[\\s\\S]*href="${escapeRegExp(versionDetailPath)}"`,
        `[\\s\\S]*${postFormPattern(approvePath)}`,
        `[\\s\\S]*${postFormPattern(rejectPath)}`,
        `[\\s\\S]*name="reason"`,
        `[\\s\\S]*</li>`,
      ].join(""),
    ),
  );
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

test("console root renders a setup-pending public landing before schema bootstrap", async () => {
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
          throw new Error('relation "tenant_memberships" does not exist');
        },
      } as unknown as AgentRegistryDb,
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
    assertPublicSignInShellContract(html);
    assert.match(html, /Architectural Precision For Tenant Operations/);
    assert.match(html, /Console Setup Pending/);
    assert.match(html, /Initialize The Console/);
    assert.match(html, /Setup Status/);
    assert.match(html, /Schema missing/);
    assert.match(html, /Bootstrap required/);
    assert.doesNotMatch(html, /Bootstrap Tenant Data/);
    assert.doesNotMatch(html, /Bootstrap Tenant Memberships/);
    assert.doesNotMatch(html, /<form[^>]+action="\/session"/);
    assert.doesNotMatch(html, /name="tenantId"/);
    assert.doesNotMatch(html, /name="subjectId"/);
    assert.doesNotMatch(html, /tenant_memberships/);
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

test("console root renders setup pending without sign-in controls when bootstrap data is missing", async () => {
  const config = loadRegistryConfig(
    {},
    {
      requireBootstrapFile: false,
    },
  );
  const server = http.createServer(
    createWebRequestListener({
      config,
      db: createEmptyConsoleDb(),
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
    assertPublicSignInShellContract(html);
    assert.match(html, /Console Setup Pending/);
    assert.match(html, /Bootstrap Tenant Data/);
    assert.match(html, /No tenants/);
    assert.match(html, /No memberships/);
    assert.doesNotMatch(html, /Schema missing/);
    assert.doesNotMatch(html, /Bootstrap Tenant Memberships/);
    assert.doesNotMatch(html, /<form[^>]+action="\/session"/);
    assert.doesNotMatch(html, /name="tenantId"/);
    assert.doesNotMatch(html, /name="subjectId"/);
    assert.doesNotMatch(html, /relation "/);
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

test("console root renders setup pending when tenants exist without memberships", async () => {
  const config = loadRegistryConfig(
    {},
    {
      requireBootstrapFile: false,
    },
  );
  const server = http.createServer(
    createWebRequestListener({
      config,
      db: createPartialBootstrapConsoleDb(),
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
    assertPublicSignInShellContract(html);
    assert.match(html, /Console Setup Pending/);
    assert.match(html, /Bootstrap Tenant Memberships/);
    assert.match(html, /Setup Status/);
    assert.match(html, /Tenants loaded/);
    assert.match(html, /No memberships/);
    assert.doesNotMatch(html, /No tenants/);
    assert.doesNotMatch(html, /Schema missing/);
    assert.doesNotMatch(html, /Bootstrap Tenant Data/);
    assert.doesNotMatch(html, /<form[^>]+action="\/session"/);
    assert.doesNotMatch(html, /name="tenantId"/);
    assert.doesNotMatch(html, /name="subjectId"/);
    assert.doesNotMatch(html, /No memberships available for/);
    assert.doesNotMatch(html, /relation "/);
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
    assert.match(html, /Internal server error\./);
    assert.doesNotMatch(html, /database offline/);
    assertRenderedDocumentUsesSharedAssets(html);
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

test("console asset routes serve shared CSS, fonts, and icons without auth", async () => {
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
          throw new Error("asset routes should not read from the database");
        },
      } as unknown as AgentRegistryDb,
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

    const baseUrl = `http://127.0.0.1:${address.port}`;

    // Act
    const stylesheetResponse = await fetch(`${baseUrl}/assets/console.css`);
    const stylesheet = await stylesheetResponse.text();
    const interFontResponse = await fetch(`${baseUrl}/assets/fonts/inter-latin-variable.woff2`);
    const interFont = await interFontResponse.arrayBuffer();
    const manropeFontResponse = await fetch(`${baseUrl}/assets/fonts/manrope-latin-variable.woff2`);
    const manropeFont = await manropeFontResponse.arrayBuffer();
    const iconsResponse = await fetch(`${baseUrl}/assets/icons.svg`);
    const icons = await iconsResponse.text();

    // Assert
    assert.equal(stylesheetResponse.status, 200);
    assert.match(stylesheetResponse.headers.get("content-type") ?? "", /^text\/css\b/);
    assert.match(stylesheet, /font-family:\s*"Manrope"/);
    assert.match(stylesheet, /font-family:\s*"Inter"/);
    assert.match(stylesheet, /\/assets\/fonts\/manrope-latin-variable\.woff2/);
    assert.match(stylesheet, /\/assets\/fonts\/inter-latin-variable\.woff2/);
    assert.equal(interFontResponse.status, 200);
    assert.match(interFontResponse.headers.get("content-type") ?? "", /^font\/woff2\b/);
    assert.ok(interFont.byteLength > 0);
    assert.equal(manropeFontResponse.status, 200);
    assert.match(manropeFontResponse.headers.get("content-type") ?? "", /^font\/woff2\b/);
    assert.ok(manropeFont.byteLength > 0);
    assert.equal(iconsResponse.status, 200);
    assert.match(iconsResponse.headers.get("content-type") ?? "", /^image\/svg\+xml\b/);
    assert.match(icons, /<symbol[^>]+id="icon-console"/);
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

test("console asset routes return 404 for unknown assets without leaking internal messages", async () => {
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
          throw new Error("asset routes should not read from the database");
        },
      } as unknown as AgentRegistryDb,
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
    const response = await fetch(`http://127.0.0.1:${address.port}/assets/missing.css`);
    const html = await response.text();

    // Assert
    assert.equal(response.status, 404);
    assert.match(html, /Asset not found\./);
    assert.doesNotMatch(html, /asset routes should not read from the database/);
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

test("console asset routes support HEAD requests without auth", async () => {
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
          throw new Error("asset routes should not read from the database");
        },
      } as unknown as AgentRegistryDb,
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
    const response = await fetch(`http://127.0.0.1:${address.port}/assets/console.css`, {
      method: "HEAD",
    });
    const body = await response.text();

    // Assert
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/css\b/);
    assert.equal(body, "");
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

test("console asset routes return 404 for unsupported methods without auth", async () => {
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
          throw new Error("asset routes should not read from the database");
        },
      } as unknown as AgentRegistryDb,
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
    const response = await fetch(`http://127.0.0.1:${address.port}/assets/console.css`, {
      method: "POST",
    });
    const html = await response.text();

    // Assert
    assert.equal(response.status, 404);
    assert.match(html, /Asset not found\./);
    assert.doesNotMatch(html, /asset routes should not read from the database/);
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

test("signed-in console returns 404 for unknown routes", async () => {
  const config = loadRegistryConfig(
    {},
    {
      requireBootstrapFile: false,
    },
  );
  const server = http.createServer(
    createWebRequestListener({
      config,
      db: createSessionStubDb(),
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

    const browser = new BrowserSession(`http://127.0.0.1:${address.port}`);

    await signIn(browser, "tenant-alpha", "publisher-alpha");

    // Act
    const response = await browser.get("/console/not-a-route");
    const html = await response.text();

    // Assert
    assert.equal(response.status, 404);
    assertAuthenticatedShellContract(html, {
      dynamicHooks: [],
      navLinks: [
        {
          href: "/console",
          label: "Overview",
        },
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
      ],
      page: "console-error",
    });
    assert.match(html, /Route not found\./);
    assert.match(html, /Return to dashboard/);
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

test("invalid version transitions return 409 without changing safe console messaging", async () => {
  const config = loadRegistryConfig(
    {},
    {
      requireBootstrapFile: false,
    },
  );
  const server = http.createServer(
    createWebRequestListener({
      config,
      db: createVersionTransitionStubDb(),
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

    const browser = new BrowserSession(`http://127.0.0.1:${address.port}`);

    await signIn(browser, "tenant-alpha", "publisher-alpha");

    // Act
    const response = await browser.postUrlEncoded(
      "/tenants/tenant-alpha/agents/agent-stub/versions/version-stub/submit",
      {},
    );
    const html = await response.text();

    // Assert
    assert.equal(response.status, 409);
    assertAuthenticatedShellContract(html, {
      dynamicHooks: [],
      navLinks: [
        {
          href: "/console",
          label: "Overview",
        },
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
      ],
      page: "console-error",
    });
    assert.match(html, /Only draft versions can be submitted\./);
    assert.match(html, /Return to dashboard/);
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

test("hosted console root renders the editorial sign-in composition and switches memberships by tenant query", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const tenantAlphaPage = await browser.get("/");
    const tenantAlphaHtml = await tenantAlphaPage.text();
    const tenantBetaPage = await browser.get("/?tenantId=tenant-beta");
    const tenantBetaHtml = await tenantBetaPage.text();

    // Assert
    assert.equal(tenantAlphaPage.status, 200);
    assert.equal(tenantBetaPage.status, 200);
    assertPublicSignInShellContract(tenantAlphaHtml);
    assertPublicSignInShellContract(tenantBetaHtml);
    assert.match(tenantAlphaHtml, /<form[^>]+action="\/session"[^>]+method="post"/);
    assert.match(tenantAlphaHtml, /<select[^>]+name="tenantId"/);
    assert.match(tenantAlphaHtml, /onchange="window\.location='\/\?tenantId='\+encodeURIComponent\(this\.value\)"/);
    assert.match(tenantAlphaHtml, /<select[^>]+name="subjectId"/);
    assert.match(tenantAlphaHtml, /admin-alpha/);
    assert.match(tenantAlphaHtml, /publisher-alpha/);
    assert.doesNotMatch(tenantAlphaHtml, /admin-beta/);
    assert.match(tenantBetaHtml, /value="tenant-beta" selected/);
    assert.match(tenantBetaHtml, /admin-beta/);
    assert.doesNotMatch(tenantBetaHtml, /admin-alpha/);
    assert.doesNotMatch(tenantBetaHtml, /publisher-alpha/);
  } finally {
    await context.close();
  }
});

test("signed-in sessions requesting console root still redirect to /console", async () => {
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

test("publisher console creates a multi-environment draft and submits it for review", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const publisherNavLinks = [
      {
        href: "/console",
        label: "Overview",
      },
      {
        href: "/tenants/tenant-alpha/drafts/new",
        label: "New Draft Registration",
      },
    ];
    const adminOnlyNavLinks = [
      {
        href: "/tenants/tenant-alpha/environments",
        label: "Environment Management",
      },
      {
        href: "/tenants/tenant-alpha/review",
        label: "Review Queue",
      },
    ];
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
    draftForm.set("publication:dev:invocationEndpoint", "https://dev.invoke.example.com");
    draftForm.set(
      "publication:dev:rawCard",
      new File(
        [
          createRawCard({
            capabilities: ["card-search", "dev-capability"],
            invocationEndpoint: undefined,
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
    draftForm.set("publication:prod:invocationEndpoint", "https://prod.invoke.example.com");
    draftForm.set(
      "publication:prod:rawCard",
      new File(
        [
          createRawCard({
            capabilities: ["card-search", "prod-capability"],
            invocationEndpoint: undefined,
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
    const submittedDashboardPage = await browser.get("/console");
    const submittedDashboardHtml = await submittedDashboardPage.text();
    const environmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const environmentsHtml = await environmentsPage.text();

    // Assert
    assert.equal(signInPage.status, 200);
    assert.equal(tenantBetaSignInPage.status, 200);
    assertPublicSignInShellContract(signInHtml);
    assertPublicSignInShellContract(tenantBetaSignInHtml);
    assert.match(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(signInHtml, /<form[^>]+action="\/session"[^>]+method="post"/);
    assert.match(signInHtml, /<select[^>]+name="subjectId"/);
    assert.match(signInHtml, /admin-alpha/);
    assert.match(signInHtml, /publisher-alpha/);
    assert.doesNotMatch(signInHtml, /admin-beta/);
    assert.match(tenantBetaSignInHtml, /admin-beta/);
    assert.doesNotMatch(tenantBetaSignInHtml, /admin-alpha/);
    assert.doesNotMatch(tenantBetaSignInHtml, /publisher-alpha/);
    assertAuthenticatedShellContract(dashboardHtml, {
      dynamicHooks: ["dashboard-actions", "dashboard-identity", "dashboard-versions"],
      navExcludes: adminOnlyNavLinks,
      navLinks: publisherNavLinks,
      page: "console-dashboard",
    });
    assertDashboardContract(dashboardHtml, {
      actionLinks: [
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
      ],
      hiddenActionHrefs: ["/tenants/tenant-alpha/environments", "/tenants/tenant-alpha/review"],
      includeActiveAgents: false,
      metrics: [
        {
          label: "Visible Versions",
          value: "0",
        },
        {
          label: "Accessible Actions",
          value: "1",
        },
      ],
      versionEmptyState: "No versions are visible for this workspace yet.",
    });
    assert.equal(newDraftPage.status, 200);
    assertAuthenticatedShellContract(newDraftHtml, {
      dynamicHooks: ["publication-sections"],
      navExcludes: adminOnlyNavLinks,
      navLinks: publisherNavLinks,
      page: "new-draft-registration",
    });
    assertDraftRegistrationFormContract(newDraftHtml, {
      environmentKeys: ["dev", "prod", "staging"],
      tenantId: "tenant-alpha",
    });
    assert.equal(createDraftResponse.status, 303);
    assert.equal(draftDetailPage.status, 200);
    assertAuthenticatedShellContract(draftDetailHtml, {
      dynamicHooks: [
        "version-overview",
        "version-metadata",
        "version-publication-contracts",
        "version-manifest",
        "publication-detail-list",
        "version-actions",
      ],
      navExcludes: adminOnlyNavLinks,
      navLinks: publisherNavLinks,
      page: "version-detail",
    });
    assert.match(draftDetailHtml, /Approval state: draft/);
    assert.match(draftDetailHtml, /Release Metadata/);
    assert.match(draftDetailHtml, /Publication Contracts/);
    assert.match(draftDetailHtml, /Technical Manifest/);
    assert.match(draftDetailHtml, /Environment Dossiers/);
    assert.match(draftDetailHtml, /Environment: dev/);
    assert.match(draftDetailHtml, /Environment: prod/);
    assert.match(draftDetailHtml, /https:\/\/dev\.invoke\.example\.com/);
    assert.match(draftDetailHtml, /https:\/\/prod\.invoke\.example\.com/);
    assert.match(draftDetailHtml, /X-User-Id/);
    assert.match(draftDetailHtml, /client_id/);
    assertPublicationDossierMarkup(draftDetailHtml, [
      {
        environmentKey: "dev",
        rawCardValue: "dev-capability",
      },
      {
        environmentKey: "prod",
        rawCardValue: "prod-capability",
      },
    ]);
    assert.match(draftDetailHtml, /Submit for Review/);
    assert.doesNotMatch(draftDetailHtml, /Approve<\/button>/);
    assert.doesNotMatch(draftDetailHtml, /Reject<\/button>/);
    assert.doesNotMatch(draftDetailHtml, /Rejected reason:/);
    assert.doesNotMatch(draftDetailHtml, /data-visual-dynamic="publication-telemetry"/);
    assert.doesNotMatch(draftDetailHtml, /data-visual-dynamic="publication-health-history"/);
    assert.equal(submitResponse.status, 303);
    assert.equal(getRedirectLocation(submitResponse), draftLocation);
    assert.equal(submittedDetailPage.status, 200);
    assertAuthenticatedShellContract(submittedDetailHtml, {
      dynamicHooks: [
        "version-overview",
        "version-metadata",
        "version-publication-contracts",
        "version-manifest",
        "publication-detail-list",
      ],
      navExcludes: adminOnlyNavLinks,
      navLinks: publisherNavLinks,
      page: "version-detail",
    });
    assert.match(submittedDetailHtml, /Approval state: pending_review/);
    assert.match(submittedDetailHtml, /Technical Manifest/);
    assert.doesNotMatch(submittedDetailHtml, /Submit for Review/);
    assert.doesNotMatch(submittedDetailHtml, /Approve<\/button>/);
    assert.doesNotMatch(submittedDetailHtml, /Reject<\/button>/);
    assert.doesNotMatch(submittedDetailHtml, /Rejected reason:/);
    assert.doesNotMatch(submittedDetailHtml, /data-visual-dynamic="publication-telemetry"/);
    assert.doesNotMatch(submittedDetailHtml, /data-visual-dynamic="publication-health-history"/);
    assert.equal(submittedDashboardPage.status, 200);
    assertAuthenticatedShellContract(submittedDashboardHtml, {
      dynamicHooks: ["dashboard-actions", "dashboard-identity", "dashboard-versions"],
      navExcludes: adminOnlyNavLinks,
      navLinks: publisherNavLinks,
      page: "console-dashboard",
    });
    assertDashboardContract(submittedDashboardHtml, {
      actionLinks: [
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
      ],
      hiddenActionHrefs: ["/tenants/tenant-alpha/environments", "/tenants/tenant-alpha/review"],
      includeActiveAgents: false,
      metrics: [
        {
          label: "Visible Versions",
          value: "1",
        },
        {
          label: "Accessible Actions",
          value: "1",
        },
      ],
      versionEmptyState: "No versions are visible for this workspace yet.",
      versionLinks: [
        {
          href: draftLocation,
          label: "Case Resolver",
        },
      ],
    });
    assert.match(submittedDashboardHtml, /Case Resolver/);
    assert.match(submittedDashboardHtml, /pending_review/);
    assert.equal(environmentsPage.status, 403);
    assert.match(environmentsHtml, /Tenant admin role is required/);
  } finally {
    await context.close();
  }
});

test("publisher console renders an honest empty publication state when no environments are configured", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    await context.db.deleteFrom("tenant_environments").where("tenant_id", "=", "tenant-alpha").execute();
    await signIn(browser, "tenant-alpha", "publisher-alpha");

    // Act
    const response = await browser.get("/tenants/tenant-alpha/drafts/new");
    const html = await response.text();

    // Assert
    assert.equal(response.status, 200);
    assertAuthenticatedShellContract(html, {
      dynamicHooks: ["publication-sections"],
      navExcludes: [
        {
          href: "/tenants/tenant-alpha/environments",
          label: "Environment Management",
        },
        {
          href: "/tenants/tenant-alpha/review",
          label: "Review Queue",
        },
      ],
      navLinks: [
        {
          href: "/console",
          label: "Overview",
        },
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
      ],
      page: "new-draft-registration",
    });
    assertDraftRegistrationFormContract(html, {
      environmentKeys: [],
      expectSubmitDisabled: true,
      tenantId: "tenant-alpha",
    });
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

test("console dashboard keeps version visibility scoped to publisher ownership while admins see the tenant-wide set", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const publisherBrowser = new BrowserSession(context.baseUrl);
  const adminBrowser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const publisherNavLinks = [
      {
        href: "/console",
        label: "Overview",
      },
      {
        href: "/tenants/tenant-alpha/drafts/new",
        label: "New Draft Registration",
      },
    ];
    const adminNavLinks = [
      {
        href: "/console",
        label: "Overview",
      },
      {
        href: "/tenants/tenant-alpha/drafts/new",
        label: "New Draft Registration",
      },
      {
        href: "/tenants/tenant-alpha/environments",
        label: "Environment Management",
      },
      {
        href: "/tenants/tenant-alpha/review",
        label: "Review Queue",
      },
    ];
    const adminOnlyNavLinks = adminNavLinks.slice(2);
    const publisherFixture = await createPendingVersion(context, {
      displayName: "Alpha Router",
      environments: ["dev"],
      publisherId: "publisher-alpha",
      summary: "Routes tenant alpha support cases.",
      versionLabel: "v1",
    });
    const otherPublisherFixture = await createPendingVersion(context, {
      displayName: "Bravo Router",
      environments: ["prod"],
      publisherId: "publisher-bravo",
      summary: "Routes another publisher's cases.",
      versionLabel: "v2",
    });

    await signIn(publisherBrowser, "tenant-alpha", "publisher-alpha");
    await signIn(adminBrowser, "tenant-alpha", "admin-alpha");

    // Act
    const publisherDashboardPage = await publisherBrowser.get("/console");
    const publisherDashboardHtml = await publisherDashboardPage.text();
    const adminDashboardPage = await adminBrowser.get("/console");
    const adminDashboardHtml = await adminDashboardPage.text();

    // Assert
    assert.equal(publisherDashboardPage.status, 200);
    assertAuthenticatedShellContract(publisherDashboardHtml, {
      dynamicHooks: ["dashboard-actions", "dashboard-identity", "dashboard-versions"],
      navExcludes: adminOnlyNavLinks,
      navLinks: publisherNavLinks,
      page: "console-dashboard",
    });
    assertDashboardContract(publisherDashboardHtml, {
      actionLinks: [
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
      ],
      hiddenActionHrefs: ["/tenants/tenant-alpha/environments", "/tenants/tenant-alpha/review"],
      identityPanel: {
        access: "Publisher workflow access",
        roleLabel: "publisher",
        subjectId: "publisher-alpha",
        tenantId: "tenant-alpha",
      },
      hiddenVersionLabels: ["Bravo Router"],
      includeActiveAgents: false,
      metrics: [
        {
          label: "Visible Versions",
          value: "1",
        },
        {
          label: "Accessible Actions",
          value: "1",
        },
      ],
      versionEmptyState: "No versions are visible for this workspace yet.",
      versionLinks: [
        {
          href: `/tenants/tenant-alpha/agents/${publisherFixture.agentId}/versions/${publisherFixture.versionId}`,
          label: "Alpha Router",
        },
      ],
    });
    assert.equal(adminDashboardPage.status, 200);
    assertAuthenticatedShellContract(adminDashboardHtml, {
      dynamicHooks: [
        "dashboard-actions",
        "dashboard-active-agents",
        "dashboard-identity",
        "dashboard-versions",
      ],
      navLinks: adminNavLinks,
      page: "console-dashboard",
    });
    assertDashboardContract(adminDashboardHtml, {
      actionLinks: [
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
        {
          href: "/tenants/tenant-alpha/environments",
          label: "Environment Management",
        },
        {
          href: "/tenants/tenant-alpha/review",
          label: "Review Queue",
        },
      ],
      activeAgentEmptyState: "No active agents are published in this tenant yet.",
      identityPanel: {
        access: "Tenant administration and publishing",
        roleLabel: "tenant-admin",
        subjectId: "admin-alpha",
        tenantId: "tenant-alpha",
      },
      includeActiveAgents: true,
      metrics: [
        {
          label: "Visible Versions",
          value: "2",
        },
        {
          label: "Active Agents",
          value: "0",
        },
      ],
      versionEmptyState: "No versions are visible for this workspace yet.",
      versionLinks: [
        {
          href: `/tenants/tenant-alpha/agents/${publisherFixture.agentId}/versions/${publisherFixture.versionId}`,
          label: "Alpha Router",
        },
        {
          href: `/tenants/tenant-alpha/agents/${otherPublisherFixture.agentId}/versions/${otherPublisherFixture.versionId}`,
          label: "Bravo Router",
        },
      ],
    });
  } finally {
    await context.close();
  }
});

test("admin active agent detail keeps overlay controls and version history honest when no version is active", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const pendingFixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev", "prod"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });

    await signIn(browser, "tenant-alpha", "admin-alpha");

    // Act
    const agentDetailPage = await browser.get(`/tenants/tenant-alpha/agents/${pendingFixture.agentId}`);
    const agentDetailHtml = await agentDetailPage.text();

    // Assert
    assert.equal(agentDetailPage.status, 200);
    assertAuthenticatedShellContract(agentDetailHtml, {
      dynamicHooks: [
        "agent-overview",
        "overlay-state",
        "active-publications",
        "environment-controls",
        "version-history",
      ],
      navLinks: [
        {
          href: "/console",
          label: "Overview",
        },
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
        {
          href: "/tenants/tenant-alpha/environments",
          label: "Environment Management",
        },
        {
          href: "/tenants/tenant-alpha/review",
          label: "Review Queue",
        },
      ],
      page: "active-agent-detail",
    });
    assert.match(
      agentDetailHtml,
      new RegExp(
        `data-visual-dynamic="agent-overview"[\\s\\S]*?<h1>${escapeRegExp(pendingFixture.agentId)}<\\/h1>`,
      ),
    );
    assert.match(agentDetailHtml, /No active approved version is currently published\./);
    assert.match(
      agentDetailHtml,
      new RegExp(
        `action="${escapeRegExp(`/tenants/tenant-alpha/agents/${pendingFixture.agentId}/overlay/deprecate`)}"`,
      ),
    );
    assert.match(
      agentDetailHtml,
      new RegExp(
        `<a[^>]+href="${escapeRegExp(`/tenants/tenant-alpha/agents/${pendingFixture.agentId}/versions/${pendingFixture.versionId}`)}"[^>]*>[\\s\\S]*?Version 1`,
      ),
    );
    assert.doesNotMatch(
      agentDetailHtml,
      new RegExp(
        `action="${escapeRegExp(`/tenants/tenant-alpha/agents/${pendingFixture.agentId}/environments/dev/overlay/deprecate`)}"`,
      ),
    );
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

test("admin dashboard excludes agents disabled by agent and environment overlays", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const adminNavLinks = [
      {
        href: "/console",
        label: "Overview",
      },
      {
        href: "/tenants/tenant-alpha/drafts/new",
        label: "New Draft Registration",
      },
      {
        href: "/tenants/tenant-alpha/environments",
        label: "Environment Management",
      },
      {
        href: "/tenants/tenant-alpha/review",
        label: "Review Queue",
      },
    ];
    const actionLinks = [
      {
        href: "/tenants/tenant-alpha/drafts/new",
        label: "New Draft Registration",
      },
      {
        href: "/tenants/tenant-alpha/environments",
        label: "Environment Management",
      },
      {
        href: "/tenants/tenant-alpha/review",
        label: "Review Queue",
      },
    ];
    const agentDisabledFixture = await createPendingVersion(context, {
      displayName: "Alpha Router",
      environments: ["prod"],
      publisherId: "publisher-alpha",
      summary: "Routes alpha support traffic.",
      versionLabel: "v1",
    });
    const environmentDisabledFixture = await createPendingVersion(context, {
      displayName: "Bravo Resolver",
      environments: ["prod"],
      publisherId: "publisher-alpha",
      summary: "Routes bravo support traffic.",
      versionLabel: "v2",
    });

    await signIn(browser, "tenant-alpha", "admin-alpha");
    await approvePendingVersion(context, agentDisabledFixture);
    await approvePendingVersion(context, environmentDisabledFixture);

    const dashboardPage = await browser.get("/console");
    const dashboardHtml = await dashboardPage.text();

    // Act
    const disableAgentResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${agentDisabledFixture.agentId}/overlay/disable`,
      {},
    );
    const disableEnvironmentResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${environmentDisabledFixture.agentId}/environments/prod/overlay/disable`,
      {},
    );
    const refreshedDashboardPage = await browser.get("/console");
    const refreshedDashboardHtml = await refreshedDashboardPage.text();
    const agentDisabledDetail = await new KyselyAgentAdminDetailRepository(context.db).getAgentDetail(
      "tenant-alpha",
      agentDisabledFixture.agentId,
    );
    const environmentDisabledDetail = await new KyselyAgentAdminDetailRepository(
      context.db,
    ).getAgentDetail("tenant-alpha", environmentDisabledFixture.agentId);

    // Assert
    assert.equal(dashboardPage.status, 200);
    assertAuthenticatedShellContract(dashboardHtml, {
      dynamicHooks: [
        "dashboard-actions",
        "dashboard-active-agents",
        "dashboard-identity",
        "dashboard-versions",
      ],
      navLinks: adminNavLinks,
      page: "console-dashboard",
    });
    assertDashboardContract(dashboardHtml, {
      actionLinks,
      activeAgentEmptyState: "No active agents are published in this tenant yet.",
      activeAgentLinks: [
        {
          href: `/tenants/tenant-alpha/agents/${agentDisabledFixture.agentId}`,
          label: "Alpha Router",
        },
        {
          href: `/tenants/tenant-alpha/agents/${environmentDisabledFixture.agentId}`,
          label: "Bravo Resolver",
        },
      ],
      includeActiveAgents: true,
      metrics: [
        {
          label: "Visible Versions",
          value: "2",
        },
        {
          label: "Active Agents",
          value: "2",
        },
      ],
      versionEmptyState: "No versions are visible for this workspace yet.",
      versionLinks: [
        {
          href: `/tenants/tenant-alpha/agents/${agentDisabledFixture.agentId}/versions/${agentDisabledFixture.versionId}`,
          label: "Alpha Router",
        },
        {
          href: `/tenants/tenant-alpha/agents/${environmentDisabledFixture.agentId}/versions/${environmentDisabledFixture.versionId}`,
          label: "Bravo Resolver",
        },
      ],
    });
    assert.equal(disableAgentResponse.status, 303);
    assert.equal(
      getRedirectLocation(disableAgentResponse),
      `/tenants/tenant-alpha/agents/${agentDisabledFixture.agentId}`,
    );
    assert.equal(disableEnvironmentResponse.status, 303);
    assert.equal(
      getRedirectLocation(disableEnvironmentResponse),
      `/tenants/tenant-alpha/agents/${environmentDisabledFixture.agentId}`,
    );
    assert.equal(agentDisabledDetail.activeVersionId, agentDisabledFixture.versionId);
    assert.equal(environmentDisabledDetail.activeVersionId, environmentDisabledFixture.versionId);
    assert.deepEqual(agentDisabledDetail.overlay.agent, {
      deprecated: false,
      disabled: true,
      requiredRoles: [],
      requiredScopes: [],
    });
    assert.deepEqual(environmentDisabledDetail.overlay.environments, [
      {
        deprecated: false,
        disabled: true,
        environmentKey: "prod",
        requiredRoles: [],
        requiredScopes: [],
      },
    ]);
    assert.equal(refreshedDashboardPage.status, 200);
    assertAuthenticatedShellContract(refreshedDashboardHtml, {
      dynamicHooks: [
        "dashboard-actions",
        "dashboard-active-agents",
        "dashboard-identity",
        "dashboard-versions",
      ],
      navLinks: adminNavLinks,
      page: "console-dashboard",
    });
    assertDashboardContract(refreshedDashboardHtml, {
      actionLinks,
      activeAgentEmptyState: "No active agents are published in this tenant yet.",
      includeActiveAgents: true,
      metrics: [
        {
          label: "Visible Versions",
          value: "2",
        },
        {
          label: "Active Agents",
          value: "0",
        },
      ],
      versionEmptyState: "No versions are visible for this workspace yet.",
      versionLinks: [
        {
          href: `/tenants/tenant-alpha/agents/${agentDisabledFixture.agentId}/versions/${agentDisabledFixture.versionId}`,
          label: "Alpha Router",
        },
        {
          href: `/tenants/tenant-alpha/agents/${environmentDisabledFixture.agentId}/versions/${environmentDisabledFixture.versionId}`,
          label: "Bravo Resolver",
        },
      ],
    });
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
    const adminNavLinks = [
      {
        href: "/console",
        label: "Overview",
      },
      {
        href: "/tenants/tenant-alpha/drafts/new",
        label: "New Draft Registration",
      },
      {
        href: "/tenants/tenant-alpha/environments",
        label: "Environment Management",
      },
      {
        href: "/tenants/tenant-alpha/review",
        label: "Review Queue",
      },
    ];
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
    const pendingRejectVersionPage = await browser.get(
      `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}`,
    );
    const pendingRejectVersionHtml = await pendingRejectVersionPage.text();
    const approveResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}/approve`,
      {},
    );

    await seedHealthAndTelemetry(context.db, approveFixture);

    const approvedVersionPage = await browser.get(
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}`,
    );
    const approvedVersionHtml = await approvedVersionPage.text();
    const refreshedDashboardPage = await browser.get("/console");
    const refreshedDashboardHtml = await refreshedDashboardPage.text();
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
    assertAuthenticatedShellContract(dashboardHtml, {
      dynamicHooks: [
        "dashboard-actions",
        "dashboard-active-agents",
        "dashboard-identity",
        "dashboard-versions",
      ],
      navLinks: adminNavLinks,
      page: "console-dashboard",
    });
    assertDashboardContract(dashboardHtml, {
      actionLinks: [
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
        {
          href: "/tenants/tenant-alpha/environments",
          label: "Environment Management",
        },
        {
          href: "/tenants/tenant-alpha/review",
          label: "Review Queue",
        },
      ],
      activeAgentEmptyState: "No active agents are published in this tenant yet.",
      includeActiveAgents: true,
      metrics: [
        {
          label: "Visible Versions",
          value: "2",
        },
        {
          label: "Active Agents",
          value: "0",
        },
      ],
      versionLinks: [
        {
          href: `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}`,
          label: "Case Router",
        },
        {
          href: `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}`,
          label: "Case Escalator",
        },
      ],
    });
    assert.equal(environmentsPage.status, 200);
    assertEnvironmentManagementPage(environmentsHtml, {
      expectedEnvironmentKeys: ["dev", "prod", "staging"],
      navLinks: adminNavLinks,
      state: "populated",
      tenantId: "tenant-alpha",
    });
    assert.equal(createEnvironmentResponse.status, 303);
    assert.equal(getRedirectLocation(createEnvironmentResponse), "/tenants/tenant-alpha/environments");
    assertEnvironmentManagementPage(updatedEnvironmentsHtml, {
      expectedEnvironmentKeys: ["dev", "prod", "qa", "staging"],
      navLinks: adminNavLinks,
      state: "populated",
      tenantId: "tenant-alpha",
    });
    assert.equal(reviewQueuePage.status, 200);
    assertAuthenticatedShellContract(reviewQueueHtml, {
      dynamicHooks: ["review-queue"],
      navLinks: adminNavLinks,
      page: "review-queue",
    });
    assert.match(reviewQueueHtml, /<ol[^>]*aria-label="Pending versions awaiting review"/);
    assertReviewQueueEntry(reviewQueueHtml, approveFixture);
    assertReviewQueueEntry(reviewQueueHtml, rejectFixture);
    assert.doesNotMatch(reviewQueueHtml, /Filter by agent ID, model, or contributor/);
    assert.doesNotMatch(reviewQueueHtml, />History</);
    assert.doesNotMatch(reviewQueueHtml, />Sort</);
    assert.doesNotMatch(reviewQueueHtml, /View Diff/);
    assert.doesNotMatch(reviewQueueHtml, /Deploy/);
    assert.equal(pendingRejectVersionPage.status, 200);
    assertAuthenticatedShellContract(pendingRejectVersionHtml, {
      dynamicHooks: [
        "version-overview",
        "version-metadata",
        "version-publication-contracts",
        "version-manifest",
        "publication-detail-list",
        "publication-telemetry",
        "version-actions",
      ],
      navLinks: adminNavLinks,
      page: "version-detail",
    });
    assert.match(pendingRejectVersionHtml, /Approval state: pending_review/);
    assert.match(pendingRejectVersionHtml, /Version Actions/);
    assert.match(
      pendingRejectVersionHtml,
      new RegExp(
        `action="${escapeRegExp(`/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}/approve`)}"`,
      ),
    );
    assert.match(
      pendingRejectVersionHtml,
      new RegExp(
        `action="${escapeRegExp(`/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}/reject`)}"`,
      ),
    );
    assert.match(pendingRejectVersionHtml, /name="reason"/);
    assert.doesNotMatch(pendingRejectVersionHtml, /Rejected reason:/);
    assert.doesNotMatch(pendingRejectVersionHtml, /data-visual-dynamic="publication-health-history"/);
    const pendingTelemetryMarkup = getVisualDynamicSectionMarkup(
      pendingRejectVersionHtml,
      "publication-telemetry",
    );
    assert.match(pendingTelemetryMarkup, /Operational Telemetry/);
    assert.match(pendingTelemetryMarkup, /No advisory telemetry submitted\./);
    assert.equal(approveResponse.status, 303);
    assert.equal(getRedirectLocation(approveResponse), `/tenants/tenant-alpha/agents/${approveFixture.agentId}`);
    assert.equal(approvedVersionPage.status, 200);
    assertAuthenticatedShellContract(approvedVersionHtml, {
      dynamicHooks: [
        "version-overview",
        "version-metadata",
        "version-publication-contracts",
        "version-manifest",
        "publication-detail-list",
        "publication-telemetry",
        "publication-health-history",
      ],
      navLinks: adminNavLinks,
      page: "version-detail",
    });
    assert.match(approvedVersionHtml, /Release Metadata/);
    assert.match(approvedVersionHtml, /Publication Contracts/);
    assert.match(approvedVersionHtml, /Technical Manifest/);
    assert.match(approvedVersionHtml, /Environment Dossiers/);
    assertPublicationDossierMarkup(approvedVersionHtml, [
      {
        environmentKey: "dev",
        rawCardValue: "dev-capability",
      },
      {
        environmentKey: "prod",
        rawCardValue: "prod-capability",
      },
    ]);
    assert.doesNotMatch(approvedVersionHtml, /data-visual-dynamic="version-actions"/);
    assert.doesNotMatch(approvedVersionHtml, /Submit for Review/);
    assert.doesNotMatch(approvedVersionHtml, /Approve<\/button>/);
    assert.doesNotMatch(approvedVersionHtml, /Reject<\/button>/);
    assert.doesNotMatch(approvedVersionHtml, /name="reason"/);
    assert.equal(refreshedDashboardPage.status, 200);
    assertAuthenticatedShellContract(refreshedDashboardHtml, {
      dynamicHooks: [
        "dashboard-actions",
        "dashboard-active-agents",
        "dashboard-identity",
        "dashboard-versions",
      ],
      navLinks: adminNavLinks,
      page: "console-dashboard",
    });
    assertDashboardContract(refreshedDashboardHtml, {
      actionLinks: [
        {
          href: "/tenants/tenant-alpha/drafts/new",
          label: "New Draft Registration",
        },
        {
          href: "/tenants/tenant-alpha/environments",
          label: "Environment Management",
        },
        {
          href: "/tenants/tenant-alpha/review",
          label: "Review Queue",
        },
      ],
      activeAgentEmptyState: "No active agents are published in this tenant yet.",
      activeAgentLinks: [
        {
          href: `/tenants/tenant-alpha/agents/${approveFixture.agentId}`,
          label: "Case Router",
        },
      ],
      includeActiveAgents: true,
      metrics: [
        {
          label: "Visible Versions",
          value: "2",
        },
        {
          label: "Active Agents",
          value: "1",
        },
      ],
      versionLinks: [
        {
          href: `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}`,
          label: "Case Router",
        },
        {
          href: `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}`,
          label: "Case Escalator",
        },
      ],
    });
    assertDocumentContainsHref(
      refreshedDashboardHtml,
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}`,
    );
    assert.doesNotMatch(refreshedDashboardHtml, /No active agents are published in this tenant yet\./);
    assert.match(approvedVersionHtml, /Health History/);
    const telemetryMarkup = getVisualDynamicSectionMarkup(
      approvedVersionHtml,
      "publication-telemetry",
    );
    assert.match(telemetryMarkup, /Invocation count: 12/);
    assert.match(telemetryMarkup, /p95 latency: 280/);
    const healthHistoryMarkup = getVisualDynamicSectionMarkup(
      approvedVersionHtml,
      "publication-health-history",
    );
    assert.match(healthHistoryMarkup, /2026-03-13T10:01:00Z/);
    assert.match(healthHistoryMarkup, /503/);
    assert.match(approvedVersionHtml, /503/);
    assert.match(approvedVersionHtml, /Invocation count: 12/);
    assert.match(approvedVersionHtml, /p95 latency: 280/);
    assert.equal(deprecateEnvironmentResponse.status, 303);
    assert.equal(
      getRedirectLocation(deprecateEnvironmentResponse),
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}`,
    );
    assert.equal(agentDetailPage.status, 200);
    assertAuthenticatedShellContract(agentDetailHtml, {
      dynamicHooks: [
        "agent-overview",
        "overlay-state",
        "active-publications",
        "environment-controls",
        "version-history",
      ],
      navLinks: adminNavLinks,
      page: "active-agent-detail",
    });
    assert.match(agentDetailHtml, /Overlay Controls/);
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
    assert.equal(rejectedVersionPage.status, 200);
    assertAuthenticatedShellContract(rejectedVersionHtml, {
      dynamicHooks: [
        "version-overview",
        "version-metadata",
        "version-publication-contracts",
        "version-manifest",
        "publication-detail-list",
        "publication-telemetry",
      ],
      navLinks: adminNavLinks,
      page: "version-detail",
    });
    assert.match(rejectedVersionHtml, /Approval state: rejected/);
    assert.match(rejectedVersionHtml, /Rejected reason: Needs clearer scopes\./);
    assert.doesNotMatch(rejectedVersionHtml, /Submit for Review/);
    assert.doesNotMatch(rejectedVersionHtml, /Approve<\/button>/);
    assert.doesNotMatch(rejectedVersionHtml, /Reject<\/button>/);
    assert.doesNotMatch(rejectedVersionHtml, /data-visual-dynamic="publication-health-history"/);
    const rejectedTelemetryMarkup = getVisualDynamicSectionMarkup(
      rejectedVersionHtml,
      "publication-telemetry",
    );
    assert.match(rejectedTelemetryMarkup, /Operational Telemetry/);
    assert.match(rejectedTelemetryMarkup, /No advisory telemetry submitted\./);
  } finally {
    await context.close();
  }
});

test("admin environment management shows a truthful empty inventory state", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const adminNavLinks = [
      {
        href: "/console",
        label: "Overview",
      },
      {
        href: "/tenants/tenant-alpha/drafts/new",
        label: "New Draft Registration",
      },
      {
        href: "/tenants/tenant-alpha/environments",
        label: "Environment Management",
      },
      {
        href: "/tenants/tenant-alpha/review",
        label: "Review Queue",
      },
    ];
    await context.db
      .deleteFrom("tenant_environments")
      .where("tenant_id", "=", "tenant-alpha")
      .execute();
    await signIn(browser, "tenant-alpha", "admin-alpha");

    // Act
    const environmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const environmentsHtml = await environmentsPage.text();

    // Assert
    assert.equal(environmentsPage.status, 200);
    assertEnvironmentManagementPage(environmentsHtml, {
      navLinks: adminNavLinks,
      state: "empty",
      tenantId: "tenant-alpha",
      unexpectedEnvironmentKeys: ["dev", "prod", "qa", "staging"],
    });
    assert.match(environmentsHtml, /Tenant tenant-alpha/);
  } finally {
    await context.close();
  }
});

test("admin environment management submits the rendered empty-state creation form", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const adminNavLinks = [
      {
        href: "/console",
        label: "Overview",
      },
      {
        href: "/tenants/tenant-alpha/drafts/new",
        label: "New Draft Registration",
      },
      {
        href: "/tenants/tenant-alpha/environments",
        label: "Environment Management",
      },
      {
        href: "/tenants/tenant-alpha/review",
        label: "Review Queue",
      },
    ];
    await context.db
      .deleteFrom("tenant_environments")
      .where("tenant_id", "=", "tenant-alpha")
      .execute();
    await signIn(browser, "tenant-alpha", "admin-alpha");

    const environmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const environmentsHtml = await environmentsPage.text();
    const creationPanel = getEnvironmentPanelMarkup(environmentsHtml, "creation");
    const creationForm = getFirstFormMarkup(creationPanel);
    const createEnvironmentAction = getFormAction(creationForm);

    // Act
    const createEnvironmentResponse = await browser.postUrlEncoded(createEnvironmentAction, {
      environmentKey: "qa",
    });
    const updatedEnvironmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const updatedEnvironmentsHtml = await updatedEnvironmentsPage.text();

    // Assert
    assert.equal(environmentsPage.status, 200);
    assertEnvironmentManagementPage(environmentsHtml, {
      navLinks: adminNavLinks,
      state: "empty",
      tenantId: "tenant-alpha",
      unexpectedEnvironmentKeys: ["dev", "prod", "qa", "staging"],
    });
    assert.equal(getFormAction(creationForm), "/tenants/tenant-alpha/environments");
    assert.match(creationForm, /<button[^>]*type="submit"[^>]*>Add Environment<\/button>/);
    assert.doesNotMatch(
      creationForm,
      /<button[^>]*type="submit"[^>]*disabled[^>]*>Add Environment<\/button>/,
    );
    assert.equal(createEnvironmentResponse.status, 303);
    assert.equal(getRedirectLocation(createEnvironmentResponse), "/tenants/tenant-alpha/environments");
    assert.equal(updatedEnvironmentsPage.status, 200);
    assertEnvironmentManagementPage(updatedEnvironmentsHtml, {
      expectedEnvironmentKeys: ["qa"],
      navLinks: adminNavLinks,
      state: "populated",
      tenantId: "tenant-alpha",
    });
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
    assertPublicSignInShellContract(signInHtml);
    assert.doesNotMatch(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(signInHtml, /type="hidden"[^>]+name="tenantId"[^>]+tenant-self-hosted/);
    assert.match(signInHtml, /<select[^>]+name="subjectId"/);
    assert.match(signInHtml, /Single-tenant deployment/);
    assert.match(signInHtml, /Tenant Self Hosted/);
    assert.doesNotMatch(signInHtml, /onchange="window\.location='\/\?tenantId='/);
    assert.match(dashboardHtml, /\/tenants\/tenant-self-hosted\/environments/);
    assert.match(dashboardHtml, /Tenant Self Hosted/);
  } finally {
    await context.close();
  }
});
