import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  createVisualRegressionFixture,
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

let fixture: VisualRegressionFixture;

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

async function signInAsAdmin(page: Page, visualFixture: VisualRegressionFixture): Promise<void> {
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
});

test.afterAll(async () => {
  await fixture.close();
});

for (const route of visualRoutes) {
  test(`matches ${route.name}`, async ({ page }, testInfo) => {
    await capturePage(page, route, testInfo);
  });
}
