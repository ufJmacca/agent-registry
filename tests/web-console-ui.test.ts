import assert from "node:assert/strict";
import test from "node:test";

import { loadRegistryConfig } from "../packages/config/src/index.ts";
import {
  KyselyAgentAdminDetailRepository,
  createKyselyDb,
  destroyKyselyDb,
  type AgentRegistryDb,
} from "../packages/db/src/index.ts";
import {
  approvePendingVersion,
  BrowserSession,
  createEmptyRegistryDatabase,
  createPendingVersion,
  createRawCard,
  createWebConsoleContext,
  getRedirectLocation,
  seedHealthAndTelemetry,
  signIn,
  startWebConsoleServer,
} from "./support/web-console-fixtures.ts";

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
  const server = await startWebConsoleServer({
    config,
    db,
  });

  try {
    const response = await fetch(`${server.baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assertUsesConsoleDocument(html);
    assert.match(html, /<h1>Agent Registry<\/h1>/);
    assert.match(html, /Console Setup Pending/);
    assert.doesNotMatch(html, /<form class="stack" action="\/session"/);
  } finally {
    await server.close();
    await destroyKyselyDb(db);
    await database.cleanup();
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
  const server = await startWebConsoleServer({
    config,
    db: {
      selectFrom() {
        throw new Error("database offline");
      },
    } as unknown as AgentRegistryDb,
  });

  try {
    const response = await fetch(`${server.baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 500);
    assertUsesConsoleDocument(html);
    assert.match(html, /Internal server error\./);
    assert.doesNotMatch(html, /database offline/);
  } finally {
    await server.close();
  }
});

test("shared fixtures expose seeded routes and telemetry-ready approved versions", async () => {
  const hostedContext = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const selfHostedContext = await createWebConsoleContext({
    deploymentMode: "self-hosted",
  });
  const detailRepository = new KyselyAgentAdminDetailRepository(hostedContext.db);

  try {
    // Arrange
    const fixture = await createPendingVersion(hostedContext, {
      agentId: "agent-case-router",
      displayName: "Case Router",
      environments: ["dev"],
      publisherId: hostedContext.subjects.publisher,
      summary: "Routes support cases.",
      tenantId: hostedContext.tenants.primary,
      versionLabel: "v1",
    });
    const pendingDetail = await detailRepository.getVersionDetail(
      fixture.tenantId,
      fixture.agentId,
      fixture.versionId,
    );
    const selfHostedBrowser = new BrowserSession(selfHostedContext.baseUrl);

    // Act
    await approvePendingVersion(hostedContext, fixture);
    const approvedDetail = await detailRepository.getVersionDetail(
      fixture.tenantId,
      fixture.agentId,
      fixture.versionId,
    );
    await seedHealthAndTelemetry(hostedContext.db, fixture);
    const telemeteredDetail = await detailRepository.getVersionDetail(
      fixture.tenantId,
      fixture.agentId,
      fixture.versionId,
    );

    const telemetryRows = await hostedContext.db
      .selectFrom("publication_telemetry")
      .select(["tenant_id", "publication_id"])
      .where("tenant_id", "=", hostedContext.tenants.primary)
      .execute();
    const healthRows = await hostedContext.db
      .selectFrom("publication_probe_history")
      .select("publication_id")
      .where("publication_id", "=", fixture.publicationIds.dev)
      .execute();

    await signIn(
      selfHostedBrowser,
      selfHostedContext.tenants.primary,
      selfHostedContext.subjects.admin,
    );
    const selfHostedDashboard = await selfHostedBrowser.get("/console");
    const selfHostedHtml = await selfHostedDashboard.text();

    // Assert
    assert.deepEqual(hostedContext.subjects, {
      admin: "admin-alpha",
      alternatePublisher: "publisher-bravo",
      publisher: "publisher-alpha",
      secondaryAdmin: "admin-beta",
    });
    assert.deepEqual(hostedContext.tenants, {
      primary: "tenant-alpha",
      secondary: "tenant-beta",
    });
    assert.deepEqual(selfHostedContext.subjects, {
      admin: "admin-self-hosted",
      publisher: "publisher-self-hosted",
    });
    assert.deepEqual(selfHostedContext.tenants, {
      primary: "tenant-self-hosted",
    });
    assert.equal(fixture.agentId, "agent-case-router");
    assert.equal(fixture.tenantId, hostedContext.tenants.primary);
    assert.equal(pendingDetail.approvalState, "pending_review");
    assert.equal(pendingDetail.active, false);
    assert.equal(pendingDetail.review.submittedBy, hostedContext.subjects.publisher);
    assert.equal(pendingDetail.review.approvedBy, null);
    assert.equal(approvedDetail.approvalState, "approved");
    assert.equal(approvedDetail.active, true);
    assert.equal(approvedDetail.review.submittedBy, hostedContext.subjects.publisher);
    assert.equal(approvedDetail.review.approvedBy, hostedContext.subjects.admin);
    assert.notEqual(approvedDetail.review.approvedAt, null);
    assert.deepEqual(
      approvedDetail.publications.map((publication) => ({
        environmentKey: publication.environmentKey,
        healthStatus: publication.healthStatus,
        publicationId: publication.publicationId,
        telemetryCount: publication.telemetry.length,
      })),
      [
        {
          environmentKey: "dev",
          healthStatus: "unknown",
          publicationId: fixture.publicationIds.dev,
          telemetryCount: 0,
        },
      ],
    );
    assert.equal(fixture.publicationIds.dev, telemetryRows[0]?.publication_id);
    assert.equal(
      fixture.routes.agentDetail,
      `/tenants/${hostedContext.tenants.primary}/agents/${fixture.agentId}`,
    );
    assert.equal(
      fixture.routes.versionDetail,
      `/tenants/${hostedContext.tenants.primary}/agents/${fixture.agentId}/versions/${fixture.versionId}`,
    );
    assert.equal(
      fixture.routes.approve,
      `/tenants/${hostedContext.tenants.primary}/agents/${fixture.agentId}/versions/${fixture.versionId}/approve`,
    );
    assert.equal(
      fixture.routes.submit,
      `/tenants/${hostedContext.tenants.primary}/agents/${fixture.agentId}/versions/${fixture.versionId}/submit`,
    );
    assert.equal(
      fixture.routes.environmentOverlays.dev.deprecate,
      `/tenants/${hostedContext.tenants.primary}/agents/${fixture.agentId}/environments/dev/overlay/deprecate`,
    );
    assert.deepEqual(
      telemeteredDetail.publications.map((publication) => ({
        environmentKey: publication.environmentKey,
        healthStatus: publication.healthStatus,
        publicationId: publication.publicationId,
        telemetryCount: publication.telemetry.length,
      })),
      [
        {
          environmentKey: "dev",
          healthStatus: "degraded",
          publicationId: fixture.publicationIds.dev,
          telemetryCount: 1,
        },
      ],
    );
    assert.equal(healthRows.length, 2);
    assert.equal(selfHostedDashboard.status, 200);
    assert.match(selfHostedHtml, /Tenant Self Hosted/);
  } finally {
    await selfHostedContext.close();
    await hostedContext.close();
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
    assert.match(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(signInHtml, /admin-alpha/);
    assert.match(signInHtml, /publisher-alpha/);
    assert.doesNotMatch(signInHtml, /admin-beta/);
    assert.match(tenantBetaSignInHtml, /admin-beta/);
    assert.doesNotMatch(tenantBetaSignInHtml, /admin-alpha/);
    assert.doesNotMatch(tenantBetaSignInHtml, /publisher-alpha/);
    assert.match(dashboardHtml, /New Draft Registration/);
    assert.doesNotMatch(dashboardHtml, /Review Queue/);
    assert.equal(newDraftPage.status, 200);
    assert.match(newDraftHtml, /type="file"/);
    assert.match(newDraftHtml, /publication:dev:enabled/);
    assert.equal(createDraftResponse.status, 303);
    assert.match(draftDetailHtml, /Approval state: draft/);
    assert.match(draftDetailHtml, /Environment: dev/);
    assert.match(draftDetailHtml, /Environment: prod/);
    assert.match(draftDetailHtml, /X-User-Id/);
    assert.match(draftDetailHtml, /client_id/);
    assert.equal(submitResponse.status, 303);
    assert.equal(getRedirectLocation(submitResponse), draftLocation);
    assert.match(submittedDetailHtml, /Approval state: pending_review/);
    assert.equal(environmentsPage.status, 403);
    assert.match(environmentsHtml, /Tenant admin role is required/);
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
    assert.match(dashboardHtml, /Environment Management/);
    assert.match(dashboardHtml, /Review Queue/);
    assert.equal(environmentsPage.status, 200);
    assert.match(environmentsHtml, /staging/);
    assert.equal(createEnvironmentResponse.status, 303);
    assert.equal(getRedirectLocation(createEnvironmentResponse), "/tenants/tenant-alpha/environments");
    assert.match(updatedEnvironmentsHtml, /qa/);
    assert.match(reviewQueueHtml, /Case Router/);
    assert.match(reviewQueueHtml, /Case Escalator/);
    assert.equal(approveResponse.status, 303);
    assert.equal(getRedirectLocation(approveResponse), `/tenants/tenant-alpha/agents/${approveFixture.agentId}`);
    assert.match(approvedVersionHtml, /Health History/);
    assert.match(approvedVersionHtml, /503/);
    assert.match(approvedVersionHtml, /Invocation count: 12/);
    assert.match(approvedVersionHtml, /p95 latency: 280/);
    assert.equal(deprecateEnvironmentResponse.status, 303);
    assert.equal(
      getRedirectLocation(deprecateEnvironmentResponse),
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}`,
    );
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
    assert.doesNotMatch(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(signInHtml, /type="hidden"[^>]+name="tenantId"[^>]+tenant-self-hosted/);
    assert.match(signInHtml, /Single-tenant deployment/);
    assert.match(dashboardHtml, /\/tenants\/tenant-self-hosted\/environments/);
    assert.match(dashboardHtml, /Tenant Self Hosted/);
  } finally {
    await context.close();
  }
});
