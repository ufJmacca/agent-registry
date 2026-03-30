import type { PublicationHealthDetailResponse } from "@agent-registry/contracts";
import type { AgentAdminDetailRecord, VersionAdminDetailRecord } from "@agent-registry/db";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { escapeHtml, renderPreformattedJson } from "../apps/web/src/ui/document.js";
import {
  formatConsoleState,
  formatConsoleTimestamp,
  installPrimitiveTestOverrides,
  resetPrimitiveTestOverrides,
  renderActionCluster,
  renderCardHead,
  renderEmptyState,
  renderFormField,
  renderFormSection,
  renderPageHero,
  renderPill,
  renderPillList,
  renderRecordList,
  renderSectionFrame,
  renderSidePanel,
  renderStatTile,
} from "../apps/web/src/ui/primitives/index.js";

const repositoryRoot = process.cwd();
const dashboardPageModuleUrl = new URL("../apps/web/src/ui/pages/dashboard.js", import.meta.url).href;
const agentDetailPageModuleUrl = new URL("../apps/web/src/ui/pages/agent-detail.js", import.meta.url).href;
const draftRegistrationPageModuleUrl = new URL(
  "../apps/web/src/ui/pages/draft-registration.js",
  import.meta.url,
).href;
const environmentManagementPageModuleUrl = new URL(
  "../apps/web/src/ui/pages/environment-management.js",
  import.meta.url,
).href;
const signInPageModuleUrl = new URL("../apps/web/src/ui/pages/sign-in.js", import.meta.url).href;
const versionDetailPageModuleUrl = new URL(
  "../apps/web/src/ui/pages/version-detail.js",
  import.meta.url,
).href;

function normalizeMarkup(markup: string): string {
  return markup.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim();
}

function assertContainsMarkup(actual: string, expected: string, message: string): void {
  assert.ok(normalizeMarkup(actual).includes(normalizeMarkup(expected)), message);
}

function buildVersionDetailFixture(): {
  actions: string[];
  detail: VersionAdminDetailRecord;
  healthByEnvironment: Map<string, PublicationHealthDetailResponse>;
} {
  const detail: VersionAdminDetailRecord = {
    active: true,
    agentId: "agent-alpha",
    approvalState: "approved",
    capabilities: ["triage", "route <urgent>"],
    cardProfileId: "card-profile-1",
    contextContract: [
      {
        description: "Selects the client partition.",
        key: "client_id",
        required: true,
        type: "string",
      },
    ],
    displayName: "Resolver <Alpha>",
    headerContract: [
      {
        description: "Identifies the tenant.",
        name: "X-Tenant-Id",
        required: true,
        source: "tenant.id",
      },
    ],
    publications: [
      {
        environmentKey: "production",
        healthEndpointUrl: "https://prod.example.com/health?scope=<all>",
        healthStatus: "healthy",
        invocationEndpoint: "https://prod.example.com/invoke",
        normalizedMetadata: {
          maintainer: "ops&support",
        },
        publicationId: "publication-1",
        rawCard: "{\"agent\":\"resolver-alpha\"}",
        telemetry: [
          {
            errorCount: 0,
            invocationCount: 12,
            p50LatencyMs: 120,
            p95LatencyMs: 240,
            recordedAt: "2026-03-13T10:30:00.000Z",
            successCount: 12,
            windowEndedAt: "2026-03-13T10:30:00.000Z",
            windowStartedAt: "2026-03-13T10:00:00.000Z",
          },
        ],
      },
    ],
    publisherId: "publisher-1",
    requiredRoles: ["tenant-admin"],
    requiredScopes: ["tickets.read"],
    review: {
      approvedAt: "2026-03-13T10:46:00.000Z",
      approvedBy: "approver-1",
      rejectedAt: null,
      rejectedBy: null,
      rejectedReason: null,
      submittedAt: "2026-03-13T10:20:00.000Z",
      submittedBy: "publisher-1",
    },
    summary: "Coordinates <critical> routing without inventing mock metadata.",
    tags: ["support", "ops"],
    versionId: "version-1",
    versionLabel: "v1",
    versionSequence: 1,
  };

  const healthByEnvironment = new Map<string, PublicationHealthDetailResponse>([
    [
      "production",
      {
        current: {
          consecutiveFailures: 0,
          healthStatus: "healthy",
          lastCheckedAt: "2026-03-13T10:47:00.000Z",
          lastError: null,
          lastSuccessAt: "2026-03-13T10:48:00.000Z",
          recentFailures: 0,
        },
        environmentKey: "production",
        history: [
          {
            checkedAt: "2026-03-13T10:49:00.000Z",
            error: null,
            ok: true,
            statusCode: 200,
          },
        ],
        publicationId: "publication-1",
      },
    ],
  ]);

  return {
    actions: [
      '<form action="/submit" method="post"><button type="submit">Submit For Review</button></form>',
      '<form action="/approve" method="post"><button type="submit">Approve</button></form>',
    ],
    detail,
    healthByEnvironment,
  };
}

function buildAgentDetailFixture(): {
  detail: AgentAdminDetailRecord;
  emptyDetail: AgentAdminDetailRecord;
} {
  return {
    detail: {
      activeVersion: {
        approvalState: "approved",
        publications: [
          {
            environmentKey: "dev",
            healthEndpointUrl: "https://dev.example.com/health",
            healthStatus: "healthy",
            publicationId: "publication-dev",
            telemetry: [],
          },
          {
            environmentKey: "prod",
            healthEndpointUrl: "https://prod.example.com/health",
            healthStatus: "degraded",
            publicationId: "publication-prod",
            telemetry: [],
          },
        ],
        review: {
          approvedAt: "2026-03-30T09:00:00.000Z",
          approvedBy: "admin-alpha",
          rejectedAt: null,
          rejectedBy: null,
          rejectedReason: null,
          submittedAt: "2026-03-29T09:00:00.000Z",
          submittedBy: "publisher-alpha",
        },
        versionId: "version-2",
        versionSequence: 2,
      },
      activeVersionId: "version-2",
      agentId: "agent-populated",
      overlay: {
        agent: {
          deprecated: true,
          disabled: false,
          requiredRoles: ["tenant-admin"],
          requiredScopes: ["agents.write"],
        },
        environments: [
          {
            deprecated: false,
            disabled: true,
            environmentKey: "prod",
            requiredRoles: ["operator"],
            requiredScopes: ["deployments.write"],
          },
        ],
      },
      versions: [
        {
          approvalState: "approved",
          versionId: "version-1",
          versionSequence: 1,
        },
        {
          approvalState: "approved",
          versionId: "version-2",
          versionSequence: 2,
        },
      ],
    },
    emptyDetail: {
      activeVersion: null,
      activeVersionId: null,
      agentId: "agent-empty",
      overlay: {
        agent: {
          deprecated: false,
          disabled: false,
          requiredRoles: [],
          requiredScopes: [],
        },
        environments: [],
      },
      versions: [],
    },
  };
}

test("document helpers escape unsafe content and preserve formatted JSON output", () => {
  // Arrange
  const unsafeText = `alpha <beta> & "gamma" 'delta'`;
  const preformattedValue = {
    copy: "<unsafe>",
  };

  // Act
  const escapedText = escapeHtml(unsafeText);
  const preformattedJson = renderPreformattedJson(preformattedValue);

  // Assert
  assert.equal(escapedText, "alpha &lt;beta&gt; &amp; &quot;gamma&quot; &#39;delta&#39;");
  assert.equal(
    preformattedJson,
    `<pre>{\n  &quot;copy&quot;: &quot;&lt;unsafe&gt;&quot;\n}</pre>`,
  );
});

test("shared primitives render the escaped wrapper markup used by the console pages", () => {
  // Arrange
  const pageHeroMarkup = renderPageHero({
    attributes: {
      "data-visual-dynamic": "hero",
    },
    body: '<div class="stack"><h1>Hero</h1></div>',
    className: "card stack page-hero--dossier",
  });
  const sectionFrameMarkup = renderSectionFrame({
    as: "article",
    attributes: {
      "data-region": "overview",
      hidden: true,
    },
    body: '<div class="surface">Operational body</div>',
    className: "page-hero card stack",
    description: "Escapes <copy> while preserving header slots.",
    eyebrow: "Curator <Shell>",
    headerClassName: "hero-header",
    headerContent: '<a href="/detail">Open detail</a>',
    leadClassName: "hero-lead",
    title: "Shared Foundation",
    titleTag: "h1",
  });
  const pillMarkup = renderPill(`Needs "Review"`, {
    attributes: {
      "data-state": "pending&review",
    },
    className: "pill--link",
    href: "/review?state=pending&tenant=alpha",
  });
  const pillListMarkup = renderPillList([]);
  const cardHeadMarkup = renderCardHead({
    className: "version-detail-card-head",
    description: "Escapes <descriptions> but keeps trailing markup raw.",
    eyebrow: "Release <Lead>",
    leadClassName: "card-head__lead--dense",
    title: "Queue & Review",
    titleTag: "h3",
    trailingContent: '<button type="button">Open</button>',
  });
  const statTileMarkup = renderStatTile({
    className: "dashboard-metric",
    descriptionMarkup: "<p><code>12</code> routed safely</p>",
    eyebrow: "Visible Versions",
    includeBaseClass: false,
    value: "12",
  });
  const actionClusterMarkup = renderActionCluster({
    actions: [
      '<button type="submit">Approve</button>',
      '<a href="/tenants/tenant-1/review">Review queue</a>',
    ],
    attributes: {
      "data-actions": "review",
    },
    className: "dashboard-action-grid",
  });
  const recordListMarkup = renderRecordList({
    attributes: {
      "data-visual-dynamic": "versions",
    },
    emptyState: '<p class="dashboard-empty">Nothing here</p>',
    items: [],
    listClassName: "dashboard-record-list",
  });
  const emptyStateMarkup = renderEmptyState({
    body: "No environments are configured yet.",
    className: "draft-empty-state",
    eyebrow: "Environment Publications",
    meta: "Empty-state copy stays truthful.",
    title: "No environments are configured yet for this tenant.",
  });
  const sidePanelMarkup = renderSidePanel({
    attributes: {
      "data-column": "secondary",
    },
    className: "version-detail-side",
    sections: [
      '<section class="card">First section</section>',
      '<section class="card">Second section</section>',
    ],
  });
  const formFieldMarkup = renderFormField({
    fieldClassName: "draft-field",
    inputMarkup: '<input name="displayName" value="Resolver" />',
    label: "Display Name",
    supportingText: "Current field names remain unchanged.",
  });
  const formSectionMarkup = renderFormSection({
    attributes: {
      "data-form-region": "metadata",
    },
    body: '<div class="draft-fields">Body</div>',
    className: "draft-section card stack",
    description: "Shared contract copy still escapes <markup>.",
    eyebrow: "General Metadata",
    headerClassName: "draft-section__header",
    headerContent: '<div class="draft-pill-row"><span class="pill">Version</span></div>',
    title: "General Metadata",
  });

  // Act
  const formattedState = formatConsoleState("pending_review");
  const formattedTimestamp = formatConsoleTimestamp("2026-03-13T10:00:00.000Z");
  const emptyTimestamp = formatConsoleTimestamp(null);

  // Assert
  assert.equal(formattedState, "Pending Review");
  assert.equal(formattedTimestamp, "2026-03-13T10:00:00Z");
  assert.equal(emptyTimestamp, "n/a");
  assert.equal(
    normalizeMarkup(pageHeroMarkup),
    '<section class="page-hero card stack page-hero--dossier" data-visual-dynamic="hero"><div class="stack"><h1>Hero</h1></div></section>',
  );
  assert.equal(
    normalizeMarkup(sectionFrameMarkup),
    normalizeMarkup(`<article class="section-frame page-hero card stack" data-region="overview" hidden>
      <div class="section-frame__header hero-header">
        <div class="section-frame__lead stack hero-lead">
          <span class="shell-eyebrow">Curator &lt;Shell&gt;</span>
          <h1>Shared Foundation</h1>
          <p class="meta">Escapes &lt;copy&gt; while preserving header slots.</p>
        </div>
        <a href="/detail">Open detail</a>
      </div>
      <div class="surface">Operational body</div>
    </article>`),
  );
  assert.equal(
    normalizeMarkup(pillMarkup),
    '<a class="pill pill--link" href="/review?state=pending&amp;tenant=alpha" data-state="pending&amp;review">Needs &quot;Review&quot;</a>',
  );
  assert.equal(pillListMarkup, '<span class="pill">none</span>');
  assert.equal(
    normalizeMarkup(cardHeadMarkup),
    normalizeMarkup(`<div class="card-head version-detail-card-head">
      <div class="card-head__lead stack card-head__lead--dense">
        <span class="shell-eyebrow">Release &lt;Lead&gt;</span>
        <h3>Queue &amp; Review</h3>
        <p class="meta">Escapes &lt;descriptions&gt; but keeps trailing markup raw.</p>
      </div>
      <button type="button">Open</button>
    </div>`),
  );
  assert.equal(
    normalizeMarkup(statTileMarkup),
    normalizeMarkup(`<div class="dashboard-metric">
      <span class="shell-eyebrow">Visible Versions</span>
      <strong>12</strong>
      <p><code>12</code> routed safely</p>
    </div>`),
  );
  assert.equal(
    normalizeMarkup(actionClusterMarkup),
    '<div class="action-cluster inline-actions dashboard-action-grid" data-actions="review"><button type="submit">Approve</button><a href="/tenants/tenant-1/review">Review queue</a></div>',
  );
  assert.equal(
    normalizeMarkup(recordListMarkup),
    '<div class="dashboard-record-list" data-visual-dynamic="versions"><p class="dashboard-empty">Nothing here</p></div>',
  );
  assert.equal(
    normalizeMarkup(emptyStateMarkup),
    normalizeMarkup(`<div class="empty-state stack draft-empty-state">
      <span class="shell-eyebrow">Environment Publications</span>
      <h3>No environments are configured yet for this tenant.</h3>
      <p>No environments are configured yet.</p>
      <p class="meta">Empty-state copy stays truthful.</p>
    </div>`),
  );
  assert.equal(
    normalizeMarkup(sidePanelMarkup),
    '<div class="side-panel version-detail-side" data-column="secondary"><section class="card">First section</section><section class="card">Second section</section></div>',
  );
  assert.equal(
    normalizeMarkup(formFieldMarkup),
    normalizeMarkup(`<label class="form-field draft-field">
      <span class="shell-eyebrow">Display Name</span>
      <input name="displayName" value="Resolver" />
      <span class="form-field__support">Current field names remain unchanged.</span>
    </label>`),
  );
  assert.equal(
    normalizeMarkup(formSectionMarkup),
    normalizeMarkup(`<section class="section-frame form-section draft-section card stack" data-form-region="metadata">
      <div class="section-frame__header draft-section__header">
        <div class="section-frame__lead stack">
          <span class="shell-eyebrow">General Metadata</span>
          <h2>General Metadata</h2>
          <p class="meta">Shared contract copy still escapes &lt;markup&gt;.</p>
        </div>
        <div class="draft-pill-row"><span class="pill">Version</span></div>
      </div>
      <div class="draft-fields">Body</div>
    </section>`),
  );
});

test(
  "sign-in page delegates its hero frame and status tiles to shared primitives",
  { concurrency: false },
  async (t) => {
  // Arrange
  const tenant = {
    displayName: "North & <Ops>",
    memberships: [
      {
        roles: ["tenant-admin", "publisher"],
        subjectId: "ada@example.com",
      },
    ],
    tenantId: "tenant-alpha",
  };
  const sectionFrameCalls: string[] = [];
  const statTileCalls: Array<[string, string | undefined]> = [];

  resetPrimitiveTestOverrides();
  t.after(() => resetPrimitiveTestOverrides());
  installPrimitiveTestOverrides({
    renderSectionFrame: (options) => {
      sectionFrameCalls.push(options.title);
      return `<sentinel-section-frame data-title="${options.title}">${options.body}</sentinel-section-frame>`;
    },
    renderStatTile: (options) => {
      statTileCalls.push([options.eyebrow, options.value]);
      return `<sentinel-stat-tile data-eyebrow="${options.eyebrow}" data-value="${options.value ?? ""}"></sentinel-stat-tile>`;
    },
  });
  const { renderInteractiveSignInPage } = await import(signInPageModuleUrl);

  // Act
  const markup = renderInteractiveSignInPage({
    deploymentMode: "hosted",
    selectedTenant: tenant,
    selfHostedTenant: tenant,
    tenants: [tenant],
  });

  // Assert
  assertContainsMarkup(
    markup,
    '<sentinel-section-frame data-title="Architectural Precision For Tenant Operations"></sentinel-section-frame>',
    "Expected the sign-in page to emit the section-frame sentinel instead of inlined hero markup.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-stat-tile data-eyebrow="Tenant" data-value="tenant-alpha"></sentinel-stat-tile>',
    "Expected the sign-in page to emit stat-tile sentinels for workspace metrics.",
  );
  assert.deepEqual(sectionFrameCalls, ["Architectural Precision For Tenant Operations"]);
  assert.deepEqual(statTileCalls, [
    ["Tenant", "tenant-alpha"],
    ["Memberships", "1"],
    ["Selection", "Hosted switcher"],
  ]);
  assert.match(markup, /<select name="tenantId"/);
  assert.match(markup, /North &amp; &lt;Ops&gt;/);
  },
);

test(
  "dashboard page delegates stat tiles, action clusters, and record lists to shared primitives",
  { concurrency: false },
  async (t) => {
  // Arrange
  const tenantId = "tenant-alpha";
  const versions = [
    {
      agentId: "agent-alpha",
      approvalState: "pending_review",
      displayName: "Case Resolver <Alpha>",
      versionId: "version-1",
      versionSequence: 7,
    },
  ];
  const statTileCalls: string[] = [];
  const actionClusterCalls: number[] = [];
  const recordListCalls: Array<{ items: number; region: string }> = [];

  resetPrimitiveTestOverrides();
  t.after(() => resetPrimitiveTestOverrides());
  installPrimitiveTestOverrides({
    renderActionCluster: (options) => {
      actionClusterCalls.push(options.actions.length);
      return `<sentinel-dashboard-actions data-count="${String(options.actions.length)}"></sentinel-dashboard-actions>`;
    },
    renderRecordList: (options) => {
      const region = String(options.attributes?.["data-visual-dynamic"] ?? "none");
      recordListCalls.push({
        items: options.items.length,
        region,
      });
      return `<sentinel-dashboard-record-list data-region="${region}" data-items="${String(options.items.length)}"></sentinel-dashboard-record-list>`;
    },
    renderStatTile: (options) => {
      statTileCalls.push(options.eyebrow);
      return `<sentinel-dashboard-stat data-eyebrow="${options.eyebrow}"></sentinel-dashboard-stat>`;
    },
  });
  const { renderDashboardPage } = await import(dashboardPageModuleUrl);

  // Act
  const markup = renderDashboardPage({
    activeAgents: [
      {
        agentId: "agent-alpha",
        displayName: "Case Resolver <Alpha>",
      },
    ],
    canPublish: true,
    isTenantAdmin: true,
    principal: {
      roles: ["tenant-admin", "publisher"],
      subjectId: "ada@example.com",
      tenantId,
    },
    tenantDisplayName: "North & <Ops>",
    versions,
  });

  // Assert
  assertContainsMarkup(
    markup,
    '<sentinel-dashboard-stat data-eyebrow="Visible Versions"></sentinel-dashboard-stat>',
    "Expected the dashboard page to emit a stat-tile sentinel for visible versions.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-dashboard-actions data-count="3"></sentinel-dashboard-actions>',
    "Expected the dashboard page to emit the action-cluster sentinel instead of local wrapper markup.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-dashboard-record-list data-region="dashboard-versions" data-items="1"></sentinel-dashboard-record-list>',
    "Expected the dashboard version register to emit the shared record-list sentinel.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-dashboard-record-list data-region="dashboard-active-agents" data-items="1"></sentinel-dashboard-record-list>',
    "Expected the active-agent inventory to emit the shared record-list sentinel.",
  );
  assert.deepEqual(statTileCalls, ["Visible Versions", "Active Agents"]);
  assert.deepEqual(actionClusterCalls, [3]);
  assert.deepEqual(recordListCalls, [
    {
      items: 1,
      region: "dashboard-versions",
    },
    {
      items: 1,
      region: "dashboard-active-agents",
    },
  ]);
  assert.match(markup, /North &amp; &lt;Ops&gt;/);
  },
);

test(
  "draft registration page delegates form wrappers and empty states to shared primitives",
  { concurrency: false },
  async (t) => {
  // Arrange
  const fieldCalls: string[] = [];
  const sectionCalls: string[] = [];
  const emptyStateCalls: string[] = [];

  resetPrimitiveTestOverrides();
  t.after(() => resetPrimitiveTestOverrides());
  installPrimitiveTestOverrides({
    renderEmptyState: (options) => {
      emptyStateCalls.push(options.title);
      return `<sentinel-empty-state data-title="${options.title}"></sentinel-empty-state>`;
    },
    renderFormField: (options) => {
      fieldCalls.push(options.label);
      return `<sentinel-form-field data-label="${options.label}"></sentinel-form-field>`;
    },
    renderFormSection: (options) => {
      sectionCalls.push(options.title);
      return `<sentinel-form-section data-title="${options.title}">${options.body}</sentinel-form-section>`;
    },
  });
  const { renderDraftRegistrationPage } = await import(draftRegistrationPageModuleUrl);
  const populatedMarkup = renderDraftRegistrationPage({
    environments: [
      {
        environmentKey: "production",
      },
    ],
    tenantId: "tenant-alpha",
  });

  // Act
  const emptyMarkup = renderDraftRegistrationPage({
    environments: [],
    tenantId: "tenant-alpha",
  });

  // Assert
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-form-field data-label="Version Label"></sentinel-form-field>',
    "Expected the draft form to emit a form-field sentinel for its metadata inputs.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-form-section data-title="General Metadata">',
    "Expected the draft page to emit a form-section sentinel for the metadata panel.",
  );
  assertContainsMarkup(
    emptyMarkup,
    '<sentinel-empty-state data-title="No environments are configured yet for this tenant."></sentinel-empty-state>',
    "Expected the draft page to emit the empty-state sentinel for missing environments.",
  );
  assert.ok(fieldCalls.includes("Version Label"));
  assert.ok(sectionCalls.includes("General Metadata"));
  assert.ok(sectionCalls.includes("Shared Contracts"));
  assert.equal(
    sectionCalls.filter((title) => title === "Environment Publications").length,
    2,
    "Expected the publication panel to render through the shared form-section helper in both populated and empty states.",
  );
  assert.deepEqual(emptyStateCalls, ["No environments are configured yet for this tenant."]);
  assert.match(emptyMarkup, /<button class="draft-action-button" type="submit" disabled>/);
  },
);

test(
  "environment management page delegates inventory framing, form wrappers, and empty states to shared primitives",
  { concurrency: false },
  async (t) => {
  // Arrange
  const emptyStateCalls: string[] = [];
  const fieldCalls: string[] = [];
  const formSectionCalls: string[] = [];
  const recordListCalls: Array<{ items: number; region: string }> = [];
  const sectionCalls: string[] = [];
  const sidePanelCalls: number[] = [];

  resetPrimitiveTestOverrides();
  t.after(() => resetPrimitiveTestOverrides());
  installPrimitiveTestOverrides({
    renderEmptyState: (options) => {
      emptyStateCalls.push(options.title);
      return `<sentinel-environment-empty data-title="${options.title}"></sentinel-environment-empty>`;
    },
    renderFormField: (options) => {
      fieldCalls.push(options.label);
      return `<sentinel-environment-field data-label="${options.label}"></sentinel-environment-field>`;
    },
    renderFormSection: (options) => {
      formSectionCalls.push(options.title);
      return `<sentinel-environment-form-section data-title="${options.title}">${options.body}</sentinel-environment-form-section>`;
    },
    renderRecordList: (options) => {
      const region = String(options.attributes?.["data-visual-dynamic"] ?? "none");
      recordListCalls.push({
        items: options.items.length,
        region,
      });
      return `<sentinel-environment-record-list data-region="${region}" data-items="${String(options.items.length)}">${
        options.items.length === 0 ? (options.emptyState ?? "") : options.items.join("")
      }</sentinel-environment-record-list>`;
    },
    renderSectionFrame: (options) => {
      sectionCalls.push(options.title);
      return `<sentinel-environment-section data-title="${options.title}">${options.headerContent ?? ""}${options.body}</sentinel-environment-section>`;
    },
    renderSidePanel: (options) => {
      sidePanelCalls.push(options.sections.length);
      return `<sentinel-environment-side-panel data-sections="${String(options.sections.length)}">${options.sections.join("")}</sentinel-environment-side-panel>`;
    },
  });
  const { renderEnvironmentManagementPage } = await import(environmentManagementPageModuleUrl);
  const populatedMarkup = renderEnvironmentManagementPage({
    environmentKeys: ["dev", "prod"],
    tenantId: "tenant-alpha",
  });

  // Act
  const emptyMarkup = renderEnvironmentManagementPage({
    environmentKeys: [],
    tenantId: "tenant-alpha",
  });

  // Assert
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-environment-section data-title="Environment Management">',
    "Expected the environment page hero to emit the shared section-frame sentinel.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-environment-section data-title="Configured Environments">',
    "Expected the inventory panel to emit the shared section-frame sentinel.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-environment-record-list data-region="environment-list" data-items="2">',
    "Expected the environment inventory to emit the shared record-list sentinel.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-environment-side-panel data-sections="2">',
    "Expected the secondary creation rail to emit the shared side-panel sentinel.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-environment-form-section data-title="Register Environment">',
    "Expected the add-environment workflow to emit the shared form-section sentinel.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-environment-field data-label="Environment key"></sentinel-environment-field>',
    "Expected the add-environment form field to emit the shared form-field sentinel.",
  );
  assert.match(populatedMarkup, /<button[^>]*type="submit"[^>]*>Add Environment<\/button>/);
  assert.doesNotMatch(
    populatedMarkup,
    /<button[^>]*type="submit"[^>]*disabled[^>]*>Add Environment<\/button>/,
  );
  assertContainsMarkup(
    emptyMarkup,
    '<sentinel-environment-empty data-title="No environments have been configured yet."></sentinel-environment-empty>',
    "Expected the empty inventory panel to emit the shared empty-state sentinel.",
  );
  assert.ok(sectionCalls.includes("Environment Management"));
  assert.equal(
    sectionCalls.filter((title) => title === "Configured Environments").length,
    2,
    "Expected the environment inventory frame to render through the shared section-frame helper in both populated and empty states.",
  );
  assert.deepEqual(recordListCalls, [
    {
      items: 2,
      region: "environment-list",
    },
    {
      items: 0,
      region: "environment-list",
    },
  ]);
  assert.deepEqual(sidePanelCalls, [2, 2]);
  assert.deepEqual(formSectionCalls, ["Register Environment", "Register Environment"]);
  assert.deepEqual(fieldCalls, ["Environment key", "Environment key"]);
  assert.deepEqual(emptyStateCalls, ["No environments have been configured yet."]);
  assert.match(populatedMarkup, /action="\/tenants\/tenant-alpha\/environments"/);
  },
);

test(
  "agent detail page delegates hero, sections, card heads, stat tiles, side panel, record lists, and empty states to shared primitives",
  { concurrency: false },
  async (t) => {
  // Arrange
  const { detail, emptyDetail } = buildAgentDetailFixture();
  const cardHeadCalls: string[] = [];
  const emptyStateCalls: string[] = [];
  const pageHeroCalls: string[] = [];
  const recordListCalls: Array<{
    items: number;
    listClassName: string | undefined;
  }> = [];
  const sectionCalls: string[] = [];
  const sidePanelCalls: number[] = [];
  const stateFormatCalls: string[] = [];
  const statTileCalls: string[] = [];

  resetPrimitiveTestOverrides();
  t.after(() => resetPrimitiveTestOverrides());
  installPrimitiveTestOverrides({
    formatConsoleState: (value) => {
      stateFormatCalls.push(value);
      return `sentinel-state:${value}`;
    },
    renderCardHead: (options) => {
      cardHeadCalls.push(options.title);
      return `<sentinel-agent-card-head data-title="${options.title}">${options.trailingContent ?? ""}</sentinel-agent-card-head>`;
    },
    renderEmptyState: (options) => {
      emptyStateCalls.push(options.title);
      return `<sentinel-agent-empty data-title="${options.title}"></sentinel-agent-empty>`;
    },
    renderPageHero: (options) => {
      pageHeroCalls.push(String(options.attributes?.["data-visual-dynamic"] ?? ""));
      return `<sentinel-agent-hero data-hook="${String(options.attributes?.["data-visual-dynamic"] ?? "")}">${options.body}</sentinel-agent-hero>`;
    },
    renderRecordList: (options) => {
      recordListCalls.push({
        items: options.items.length,
        listClassName: options.listClassName,
      });
      return `<sentinel-agent-record-list data-items="${String(options.items.length)}" data-class="${escapeHtml(options.listClassName ?? "")}">${options.items.length === 0 ? (options.emptyState ?? "") : options.items.join("")}</sentinel-agent-record-list>`;
    },
    renderSectionFrame: (options) => {
      sectionCalls.push(options.title);
      return `<sentinel-agent-section data-title="${options.title}">${options.body}</sentinel-agent-section>`;
    },
    renderSidePanel: (options) => {
      sidePanelCalls.push(options.sections.length);
      return `<sentinel-agent-side-panel data-sections="${String(options.sections.length)}">${options.sections.join("")}</sentinel-agent-side-panel>`;
    },
    renderStatTile: (options) => {
      statTileCalls.push(options.eyebrow);
      return `<sentinel-agent-stat data-eyebrow="${options.eyebrow}"></sentinel-agent-stat>`;
    },
  });
  const { renderAgentDetailPage } = await import(agentDetailPageModuleUrl);

  // Act
  const populatedMarkup = renderAgentDetailPage({
    detail,
    tenantId: "tenant-alpha",
  });
  const emptyMarkup = renderAgentDetailPage({
    detail: emptyDetail,
    tenantId: "tenant-alpha",
  });

  // Assert
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-agent-hero data-hook="agent-overview">',
    "Expected the agent overview to render through the shared page-hero primitive.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-agent-side-panel data-sections="2">',
    "Expected the overlay and environment control column to render through the shared side-panel primitive.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-agent-card-head data-title="dev">',
    "Expected publication cards to render through the shared card-head primitive.",
  );
  assertContainsMarkup(
    populatedMarkup,
    '<sentinel-agent-stat data-eyebrow="Tenant"></sentinel-agent-stat>',
    "Expected the dossier summary facts to render through the shared stat-tile primitive.",
  );
  assertContainsMarkup(
    populatedMarkup,
    'data-class="record-list record-list--publication-cards agent-detail-publication-list"',
    "Expected active publications to render through the shared record-list primitive.",
  );
  assertContainsMarkup(
    populatedMarkup,
    'data-class="record-list record-list--history agent-detail-history-list"',
    "Expected version history to render through the shared record-list primitive.",
  );
  assertContainsMarkup(
    emptyMarkup,
    '<sentinel-agent-empty data-title="No active approved version is currently published."></sentinel-agent-empty>',
    "Expected the no-approved-version state to render through the shared empty-state primitive.",
  );
  assertContainsMarkup(
    emptyMarkup,
    '<sentinel-agent-empty data-title="No environment overlays have been applied."></sentinel-agent-empty>',
    "Expected the no-environment-overlay state to render through the shared empty-state primitive.",
  );
  assertContainsMarkup(
    emptyMarkup,
    '<sentinel-agent-empty data-title="No versions have been registered for this agent yet."></sentinel-agent-empty>',
    "Expected the no-version-history state to render through the shared empty-state primitive.",
  );
  assert.deepEqual(pageHeroCalls, ["agent-overview", "agent-overview"]);
  assert.ok(sectionCalls.includes("Active Publications"));
  assert.ok(sectionCalls.includes("Overlay Controls"));
  assert.ok(sectionCalls.includes("Environment Controls"));
  assert.ok(sectionCalls.includes("Version History"));
  assert.deepEqual(sidePanelCalls, [2, 2]);
  assert.ok(cardHeadCalls.includes("Agent overlay"));
  assert.ok(cardHeadCalls.includes("Environment overlay for prod"));
  assert.ok(cardHeadCalls.includes("dev"));
  assert.ok(cardHeadCalls.includes("prod"));
  assert.equal(statTileCalls.filter((value) => value === "Tenant").length, 2);
  assert.deepEqual(recordListCalls, [
    {
      items: 1,
      listClassName: "record-list record-list--overlay-state agent-detail-overlay-list",
    },
    {
      items: 2,
      listClassName: "record-list record-list--publication-cards agent-detail-publication-list",
    },
    {
      items: 2,
      listClassName: "record-list record-list--environment-controls agent-detail-control-list",
    },
    {
      items: 2,
      listClassName: "record-list record-list--history agent-detail-history-list",
    },
  ]);
  assert.deepEqual(emptyStateCalls, [
    "No environment overlays have been applied.",
    "No active approved version is currently published.",
    "No environment overlays can be applied until an approved version is active.",
    "No versions have been registered for this agent yet.",
  ]);
  assert.deepEqual(stateFormatCalls, ["approved", "approved", "approved", "approved", "approved"]);
  assert.match(populatedMarkup, /data-agent-detail-layout="dossier"/);
  assert.match(
    populatedMarkup,
    /action="\/tenants\/tenant-alpha\/agents\/agent-populated\/environments\/prod\/overlay\/disable"/,
  );
  },
);

test(
  "version detail page delegates dossier wrappers and formatter output to shared primitives while keeping document JSON rendering",
  { concurrency: false },
  async (t) => {
  // Arrange
  const { actions, detail, healthByEnvironment } = buildVersionDetailFixture();
  const actionClusterCalls: number[] = [];
  const cardHeadCalls: string[] = [];
  const pillListCalls: number[] = [];
  const sidePanelCalls: number[] = [];
  const stateFormatCalls: string[] = [];
  const statTileCalls: string[] = [];
  const timestampFormatCalls: Array<string | null> = [];

  resetPrimitiveTestOverrides();
  t.after(() => resetPrimitiveTestOverrides());
  installPrimitiveTestOverrides({
    formatConsoleState: (value) => {
      stateFormatCalls.push(value);
      return `sentinel-state:${value}`;
    },
    formatConsoleTimestamp: (value) => {
      timestampFormatCalls.push(value);
      return `sentinel-timestamp:${value ?? "null"}`;
    },
    renderActionCluster: (options) => {
      actionClusterCalls.push(options.actions.length);
      return `<sentinel-version-actions data-count="${String(options.actions.length)}"></sentinel-version-actions>`;
    },
    renderCardHead: (options) => {
      cardHeadCalls.push(options.title);
      return `<sentinel-card-head data-title="${options.title}">${options.trailingContent ?? ""}</sentinel-card-head>`;
    },
    renderPillList: (values) => {
      pillListCalls.push(values.length);
      return `<sentinel-pill-list data-count="${String(values.length)}"></sentinel-pill-list>`;
    },
    renderSidePanel: (options) => {
      sidePanelCalls.push(options.sections.length);
      return `<sentinel-side-panel data-sections="${String(options.sections.length)}">${options.sections.join("")}</sentinel-side-panel>`;
    },
    renderStatTile: (options) => {
      statTileCalls.push(options.eyebrow);
      return `<sentinel-version-stat data-eyebrow="${options.eyebrow}"></sentinel-version-stat>`;
    },
  });
  const { renderVersionDetailPageBody } = await import(versionDetailPageModuleUrl);

  // Act
  const markup = renderVersionDetailPageBody({
    actions,
    detail,
    healthByEnvironment,
    isTenantAdmin: true,
    tenantId: "tenant-alpha",
  });

  // Assert
  assertContainsMarkup(
    markup,
    '<sentinel-card-head data-title="production">',
    "Expected the environment dossier to emit the shared card-head sentinel.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-version-actions data-count="2"></sentinel-version-actions>',
    "Expected the version actions panel to emit the shared action-cluster sentinel.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-version-stat data-eyebrow="Approval State"></sentinel-version-stat>',
    "Expected the release metadata panel to emit the shared stat-tile sentinel.",
  );
  assertContainsMarkup(
    markup,
    renderPreformattedJson(detail.headerContract),
    "Expected dossier JSON panels to use the document preformatted-json helper.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-pill-list data-count="2"></sentinel-pill-list>',
    "Expected capability badges to emit the shared pill-list sentinel.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-side-panel data-sections="3">',
    "Expected the right-column dossier rail to emit the shared side-panel sentinel.",
  );
  assertContainsMarkup(
    markup,
    '<sentinel-card-head data-title="Release Metadata">',
    "Expected the release metadata rail to emit the shared card-head sentinel.",
  );
  assert.equal(
    markup.match(/sentinel-state:approved/g)?.length ?? 0,
    2,
    "Expected the hero and release metadata panels to render state text through the shared formatter.",
  );
  assertContainsMarkup(
    markup,
    "sentinel-timestamp:2026-03-13T10:20:00.000Z",
    "Expected the review timeline to render submitted timestamps through the shared formatter.",
  );
  assertContainsMarkup(
    markup,
    "sentinel-timestamp:2026-03-13T10:00:00.000Z",
    "Expected the telemetry panel to render window timestamps through the shared formatter.",
  );
  assertContainsMarkup(
    markup,
    "sentinel-timestamp:2026-03-13T10:47:00.000Z",
    "Expected the health history panel to render current health timestamps through the shared formatter.",
  );
  assertContainsMarkup(
    markup,
    "sentinel-timestamp:2026-03-13T10:49:00.000Z",
    "Expected the health history timeline to render probe timestamps through the shared formatter.",
  );
  assert.ok(cardHeadCalls.includes("production"));
  assert.ok(cardHeadCalls.includes("Release Metadata"));
  assert.deepEqual(actionClusterCalls, [2]);
  assert.deepEqual(pillListCalls, [2, 2]);
  assert.deepEqual(sidePanelCalls, [3]);
  assert.deepEqual(stateFormatCalls, ["approved", "approved"]);
  assert.ok(statTileCalls.includes("Approval State"));
  assert.deepEqual(timestampFormatCalls, [
    "2026-03-13T10:20:00.000Z",
    "2026-03-13T10:46:00.000Z",
    "2026-03-13T10:00:00.000Z",
    "2026-03-13T10:30:00.000Z",
    "2026-03-13T10:47:00.000Z",
    "2026-03-13T10:48:00.000Z",
    "2026-03-13T10:49:00.000Z",
  ]);
  assert.match(markup, /Resolver &lt;Alpha&gt;/);
  },
);

test("console stylesheet declares ordered layers for base, shell, primitives, pages, and responsive overrides", async () => {
  // Arrange
  const stylesheetPath = path.join(repositoryRoot, "apps", "web", "assets", "console.css");
  const stylesheet = await readFile(stylesheetPath, "utf8");

  // Act
  const layerDeclarationIndex = stylesheet.indexOf(
    "@layer tokens, base, shell, primitives, pages, responsive;",
  );
  const shellLayerIndex = stylesheet.indexOf("@layer shell {");
  const primitivesLayerIndex = stylesheet.indexOf("@layer primitives {");
  const pagesLayerIndex = stylesheet.indexOf("@layer pages {");
  const responsiveLayerIndex = stylesheet.indexOf("@layer responsive {");

  // Assert
  assert.notEqual(layerDeclarationIndex, -1, "Expected a top-level ordered layer declaration");
  assert.ok(shellLayerIndex > layerDeclarationIndex, "Expected shell rules to live in @layer shell");
  assert.ok(
    primitivesLayerIndex > shellLayerIndex,
    "Expected shared primitive rules to follow the shell layer",
  );
  assert.ok(
    pagesLayerIndex > primitivesLayerIndex,
    "Expected page-specific rules to follow shared primitives",
  );
  assert.ok(
    responsiveLayerIndex > pagesLayerIndex,
    "Expected responsive overrides to be isolated in the final layer",
  );
  assert.match(
    stylesheet,
    /@layer primitives \{[\s\S]*\.pill[\s\S]*\.inline-actions[\s\S]*\.card-head/,
  );
  assert.match(stylesheet, /@layer pages \{[\s\S]*\.sign-in-landing/);
  assert.match(stylesheet, /@layer pages \{[\s\S]*\.dashboard-grid/);
  assert.match(stylesheet, /@layer pages \{[\s\S]*\.draft-form/);
  assert.match(stylesheet, /@layer pages \{[\s\S]*\.version-detail-grid/);
  assert.match(stylesheet, /@layer responsive \{[\s\S]*@media/);
});
