import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  approvePendingVersion,
  createPendingVersion,
  createRawCard,
  createWebConsoleContext,
  createVisualRegressionFixture,
  seedHealthAndTelemetry,
  type VisualRegressionFixture,
} from "../support/web-console.ts";

const visualRoutes = [
  {
    name: "sign-in-landing",
    pathname: (fixture: VisualRegressionFixture) => fixture.routes.signInLanding,
    requiresSignIn: false,
  },
  {
    name: "console-dashboard",
    pathname: (fixture: VisualRegressionFixture) => fixture.routes.consoleDashboard,
    requiresSignIn: true,
  },
  {
    name: "environment-management",
    pathname: (fixture: VisualRegressionFixture) => fixture.routes.environmentManagement,
    requiresSignIn: true,
  },
  {
    name: "new-draft-registration",
    pathname: (fixture: VisualRegressionFixture) => fixture.routes.newDraftRegistration,
    requiresSignIn: true,
  },
  {
    name: "review-queue",
    pathname: (fixture: VisualRegressionFixture) => fixture.routes.reviewQueue,
    requiresSignIn: true,
  },
  {
    name: "active-agent-detail",
    pathname: (fixture: VisualRegressionFixture) => fixture.routes.activeAgentDetail,
    requiresSignIn: true,
  },
  {
    name: "version-detail",
    pathname: (fixture: VisualRegressionFixture) => fixture.routes.versionDetail,
    requiresSignIn: true,
  },
] as const;

interface AdminSignInFixture {
  baseUrl: string;
  routes: {
    consoleDashboard: string;
    signInLanding: string;
  };
  tenantId: string;
}

interface LongPayloadVisualFixture extends AdminSignInFixture {
  close(): Promise<void>;
  routes: AdminSignInFixture["routes"] & {
    versionDetail: string;
  };
}

let fixture: VisualRegressionFixture;
let longPayloadFixture: LongPayloadVisualFixture;

function isMobileProject(testInfo: TestInfo): boolean {
  return testInfo.project.name.endsWith("mobile");
}

async function prepareForSnapshot(page: Page): Promise<void> {
  await page.emulateMedia({
    reducedMotion: "reduce",
  });
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.evaluate(() => {
    const uuidPattern =
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      node.textContent = node.textContent?.replace(
        uuidPattern,
        "11111111-1111-1111-1111-111111111111",
      ) ?? "";
    }
  });
}

async function signInAsAdmin(page: Page, visualFixture: AdminSignInFixture): Promise<void> {
  await page.goto(`${visualFixture.baseUrl}${visualFixture.routes.signInLanding}`);

  if ((await page.locator('select[name="tenantId"]').count()) > 0) {
    await page.selectOption('select[name="tenantId"]', visualFixture.tenantId);
  }

  await page.selectOption('select[name="subjectId"]', "admin-alpha");
  await Promise.all([
    page.waitForURL(`${visualFixture.baseUrl}${visualFixture.routes.consoleDashboard}`),
    page.locator('form[action="/session"] button[type="submit"]').click(),
  ]);
}

async function createLongPayloadFixture(): Promise<LongPayloadVisualFixture> {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });

  try {
    const longToken = `trace-${"segment".repeat(18)}`;
    const sharedSummary =
      "Curates long manifest and raw-card payloads without introducing unsupported controls.";
    const approvedFixture = await createPendingVersion(context, {
      capabilities: ["shared-capability", longToken],
      contextContract: [
        {
          description:
            "Preserves a deliberately long routing partition example so the mobile dossier shows raw payload handling truthfully.",
          example: `partition-${"1234567890".repeat(12)}`,
          key: `routing_${"partition".repeat(8)}`,
          required: true,
          type: "string",
        },
      ],
      displayName: "Network Cartographer",
      environments: ["dev", "prod"],
      headerContract: [
        {
          description:
            "Threads a long reviewer attribution key through the publication envelope without inventing copy utilities.",
          name: `X-Trace-${"Header".repeat(8)}`,
          required: true,
          source: "session.traceId",
        },
      ],
      publications: ["dev", "prod"].map((environmentKey) => ({
        environmentKey,
        healthEndpointUrl: `https://${environmentKey}.health.example.com/status`,
        rawCard: createRawCard({
          capabilities: ["card-search", `${environmentKey}-${longToken}`],
          compatibilityWindow: `${environmentKey}-${"window".repeat(16)}`,
          name: "Network Cartographer",
          summary: sharedSummary,
          tags: [`scope-${"tag".repeat(16)}`, environmentKey],
        }),
      })),
      publisherId: "publisher-alpha",
      requiredRoles: ["support-agent", `reviewer-${"ops".repeat(10)}`],
      requiredScopes: ["tickets.read", `contracts.${"scope".repeat(12)}`],
      summary: sharedSummary,
      tags: ["shared-tag", `metadata-${"atlas".repeat(12)}`],
      versionLabel: "v-mobile-long",
    });

    await approvePendingVersion(context, approvedFixture);
    await seedHealthAndTelemetry(context.db, approvedFixture);

    return {
      ...context,
      routes: {
        consoleDashboard: "/console",
        signInLanding: "/",
        versionDetail: `/tenants/tenant-alpha/agents/${approvedFixture.agentId}/versions/${approvedFixture.versionId}`,
      },
      tenantId: "tenant-alpha",
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function capturePage(
  page: Page,
  route: (typeof visualRoutes)[number],
  testInfo: TestInfo,
): Promise<void> {
  if (route.requiresSignIn) {
    await signInAsAdmin(page, fixture);
  }

  // Arrange
  await page.goto(`${fixture.baseUrl}${route.pathname(fixture)}`);
  await page.waitForLoadState("networkidle");
  await prepareForSnapshot(page);

  // Act
  const dynamicRegions = page.locator("[data-visual-dynamic]");
  const viewportLabel = testInfo.project.name.endsWith("mobile") ? "mobile" : "desktop";

  // Assert
  await expect(page).toHaveScreenshot(`${route.name}-${viewportLabel}.png`, {
    animations: "disabled",
    caret: "hide",
    fullPage: true,
    mask: [dynamicRegions],
    maskColor: "#91a3bc",
    scale: "css",
  });
}

test.beforeAll(async () => {
  fixture = await createVisualRegressionFixture();
  longPayloadFixture = await createLongPayloadFixture();
});

test.afterAll(async () => {
  await longPayloadFixture?.close();
  await fixture.close();
});

for (const route of visualRoutes) {
  test(`matches ${route.name}`, async ({ page }, testInfo) => {
    await capturePage(page, route, testInfo);
  });
}

test("version-detail mobile keeps long manifest and raw-card payloads contained", async ({
  page,
}, testInfo) => {
  test.skip(!isMobileProject(testInfo), "This coverage targets the required mobile dossier overflow case.");

  // Arrange
  await signInAsAdmin(page, longPayloadFixture);
  await page.goto(`${longPayloadFixture.baseUrl}${longPayloadFixture.routes.versionDetail}`);
  await page.waitForLoadState("networkidle");
  await prepareForSnapshot(page);

  const manifestSection = page.locator('[data-visual-dynamic="version-manifest"]');
  const publicationSection = page.locator('[data-visual-dynamic="publication-detail-list"]');
  const payloadPanels = page.locator(
    '[data-visual-dynamic="version-manifest"] pre, .version-detail-raw-card pre',
  );

  // Act
  const viewportMetrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  const payloadMetrics = await payloadPanels.evaluateAll((nodes) =>
    nodes.map((node) => {
      const element = node as HTMLElement;

      return {
        clientWidth: element.clientWidth,
        overflowX: window.getComputedStyle(element).overflowX,
        scrollWidth: element.scrollWidth,
      };
    }),
  );

  // Assert
  expect(viewportMetrics.scrollWidth).toBeLessThanOrEqual(viewportMetrics.clientWidth + 1);
  expect(payloadMetrics.length).toBeGreaterThanOrEqual(3);
  expect(payloadMetrics.some((metric) => metric.scrollWidth > metric.clientWidth)).toBeTruthy();

  for (const metric of payloadMetrics) {
    expect(metric.overflowX).toBe("auto");
  }

  await expect(manifestSection).toHaveScreenshot("version-detail-mobile-proof-manifest.png", {
    animations: "disabled",
    caret: "hide",
    scale: "css",
  });
  await expect(publicationSection).toHaveScreenshot(
    "version-detail-mobile-proof-publications.png",
    {
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  );
});
