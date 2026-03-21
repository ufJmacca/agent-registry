import { type Locator, type Page } from "@playwright/test";

import { expect, signInAs, test, waitForVisualReadiness } from "../support/web-console-fixtures.ts";

function buildMask(page: Page, scenarioName: string): Locator[] {
  if (scenarioName === "active-agent-detail") {
    return [
      page.locator(".agent-detail-hero h1"),
      page.locator(".agent-detail-summary-grid"),
      page.locator(".agent-detail-history__item code"),
    ];
  }

  if (scenarioName === "version-detail") {
    return [
      page.locator(".version-detail-manifest-panel"),
      page.locator(".version-detail-metadata-card"),
    ];
  }

  return [];
}

for (const scenarioName of [
  "landing",
  "console-dashboard",
  "environment-management",
  "draft-registration",
  "review-queue",
  "active-agent-detail",
  "version-detail",
] as const) {
  test(`${scenarioName} stays aligned to the approved technical curator baseline`, async ({
    page,
    visualConsole,
  }) => {
    // Arrange
    const scenario = visualConsole.scenarios.find((entry) => entry.name === scenarioName);

    if (scenario === undefined) {
      throw new Error(`Expected seeded visual scenario '${scenarioName}'.`);
    }

    if (scenario.role === "admin" || scenario.role === "publisher") {
      await signInAs(page, visualConsole, scenario.role);
    }

    // Act
    await page.goto(`${visualConsole.baseUrl}${scenario.pathname}`, { waitUntil: "networkidle" });
    await waitForVisualReadiness(page);

    // Assert
    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(horizontalOverflow).toBeLessThanOrEqual(1);
    await expect(page).toHaveScreenshot(`${scenario.name}.png`, {
      animations: "disabled",
      fullPage: true,
      mask: buildMask(page, scenario.name),
      maskColor: "#e8eef4",
    });
  });
}
