import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();
const screenshotDirectory = path.join(repositoryRoot, "tests", "visual", "__screenshots__");
const placeholderPattern = /\b(?:_TBD_|TBD|TODO|placeholder)\b/i;

const expectedScreenshots = [
  "sign-in-landing-desktop.png",
  "sign-in-landing-mobile.png",
  "console-dashboard-desktop.png",
  "console-dashboard-mobile.png",
  "environment-management-desktop.png",
  "environment-management-mobile.png",
  "new-draft-registration-desktop.png",
  "new-draft-registration-mobile.png",
  "review-queue-desktop.png",
  "review-queue-mobile.png",
  "active-agent-detail-desktop.png",
  "active-agent-detail-mobile.png",
  "version-detail-desktop.png",
  "version-detail-mobile.png",
] as const;

const requiredReviewRoutes = [
  "/",
  "/console",
  "/tenants/:tenantId/environments",
  "/tenants/:tenantId/drafts/new",
  "/tenants/:tenantId/review",
  "/tenants/:tenantId/agents/:agentId",
  "/tenants/:tenantId/agents/:agentId/versions/:versionId",
] as const;

const requiredSignOffNarrativeFields = [
  "Approver/design authority",
  "Review date",
  "Reference code.html reviewed by",
  "Reference screen.png reviewed by",
  "Baseline set",
] as const;

const requiredSignOffStatusFields = [
  "Manual checklist status",
  "Dead controls audit",
] as const;

const requiredRouteSupportFields = [
  "Reference assets",
  "Review evidence",
] as const;

const requiredReviewFields = [
  "Shell composition and overall layout",
  "Headline scale and spacing",
  "CTA treatment and hierarchy",
  "Card and background layering",
  "Navigation treatment",
  "Information density and grouping",
  "Functional constraints to preserve",
  "Intentional deviations and truthful substitutions",
] as const;

const requiredReferenceAuditHeadings = [
  "## Reference Audit Overview",
  "## Reference Audit Shared Patterns",
  "## Reference Audit Route Matrix",
  "## Reference Audit Residual Delta Log",
] as const;

const expectedReferenceAuditOverviewHeaders = [
  "Audit focus",
  "Reference evidence",
  "Implementation consequence",
] as const;

const expectedReferenceAuditSharedPatternHeaders = [
  "Pattern group",
  "Observed across references",
  "Audit implication for implementation",
] as const;

const expectedReferenceAuditRouteMatrixHeaders = [
  "Current route",
  "Reference asset pair",
  "Shared patterns carried forward",
  "Route-unique reference pattern",
  "Truthful substitutions required",
  "Mock-only elements to omit",
] as const;

const expectedReferenceAuditResidualDeltaHeaders = [
  "Current route",
  "Audit pass",
  "Highest-value unresolved fidelity delta",
  "Truthful constraint to preserve",
  "Next implementation target",
] as const;

const expectedSharedPatternGroups = [
  "Public shell traits",
  "Authenticated shell traits",
  "Repeated component patterns",
  "Truthful substitutions policy",
  "Mock-only omissions policy",
] as const;

const expectedOmissionRows = [
  { route: "/", asset: "sign_in_landing_page" },
  { route: "/console", asset: "console_dashboard" },
  { route: "/tenants/:tenantId/environments", asset: "environment_management" },
  { route: "/tenants/:tenantId/drafts/new", asset: "new_draft_registration" },
  { route: "/tenants/:tenantId/review", asset: "review_queue" },
  { route: "/tenants/:tenantId/agents/:agentId", asset: "active_agent_detail" },
  { route: "/tenants/:tenantId/agents/:agentId/versions/:versionId", asset: "version_detail" },
] as const;

const expectedChecklistItems = [
  "No-Line Rule",
  "Surface hierarchy",
  "Glass treatment",
  "CTA treatment",
  "Typography: Manrope headlines",
  "Typography: Inter body",
  "Palette",
  "Layout rhythm",
  "Card structure",
  "Shadows",
  "Shared shell",
  "Responsiveness and accessibility",
] as const;

const expectedVersionDetailDeviations = [
  "Mock latency / throughput / memory KPI cards in the dossier hero",
  "Mock review checklist badges such as unit tests passed and security audit clear",
  "Mock audit-history narrative and side metadata such as license and production-ready environment labels",
  "Copy-JSON affordance and richer mock manifest utilities",
] as const;

type MarkdownTableRow = Record<string, string>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractSection(notes: string, heading: string): string {
  const headingPattern = new RegExp(`^${escapeRegExp(heading)}$`, "m");
  const headingMatch = headingPattern.exec(notes);
  assert.ok(headingMatch, `Expected section heading ${heading}`);

  const remainingNotes = notes.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingIndex = remainingNotes.search(/^## |^### /m);

  return nextHeadingIndex === -1
    ? remainingNotes
    : remainingNotes.slice(0, nextHeadingIndex);
}

function extractTopLevelSection(notes: string, heading: string): string {
  const headingPattern = new RegExp(`^${escapeRegExp(heading)}$`, "m");
  const headingMatch = headingPattern.exec(notes);
  assert.ok(headingMatch, `Expected section heading ${heading}`);

  const remainingNotes = notes.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingIndex = remainingNotes.search(/^## /m);

  return nextHeadingIndex === -1
    ? remainingNotes
    : remainingNotes.slice(0, nextHeadingIndex);
}

function parseMarkdownTableLine(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^`(.+)`$/, "$1"));
}

function parseMarkdownTable(
  notes: string,
  heading: string,
  expectedHeaders: string[],
): MarkdownTableRow[] {
  const section = extractSection(notes, heading);
  const tableLines = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  assert.ok(tableLines.length >= 3, `Expected a markdown table under ${heading}`);

  const headers = parseMarkdownTableLine(tableLines[0]);
  assert.deepEqual(headers, expectedHeaders, `Unexpected headers for ${heading}`);

  return tableLines.slice(2).map((line) => {
    const cells = parseMarkdownTableLine(line);
    assert.equal(
      cells.length,
      headers.length,
      `Expected ${headers.length} cells in ${heading}, found ${cells.length}`,
    );

    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  });
}

function extractBulletValue(section: string, label: string): string {
  const bulletPattern = new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, "m");
  const bulletMatch = bulletPattern.exec(section);

  assert.ok(bulletMatch, `Expected bullet for ${label}`);

  return bulletMatch[1].trim();
}

function assertCompletedNarrative(value: string, label: string): void {
  assert.ok(value.length >= 12, `Expected ${label} to contain completed review text`);
  assert.match(value, /[A-Za-z]/, `Expected ${label} to contain readable content`);
  assert.doesNotMatch(value, placeholderPattern, `Expected ${label} to avoid placeholders`);
}

test(
  "implementation notes include the required reference audit block before sign-off with exact machine-readable tables",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const signOffHeadingIndex = notes.indexOf("## Sign-Off Record");

    // Assert
    assert.notEqual(signOffHeadingIndex, -1, "Expected a sign-off record section");

    for (const heading of requiredReferenceAuditHeadings) {
      const headingIndex = notes.indexOf(heading);
      assert.notEqual(headingIndex, -1, `Expected audit heading ${heading}`);
      assert.ok(
        headingIndex < signOffHeadingIndex,
        `Expected ${heading} to appear before ## Sign-Off Record`,
      );
    }

    const overviewRows = parseMarkdownTable(
      notes,
      "## Reference Audit Overview",
      [...expectedReferenceAuditOverviewHeaders],
    );
    assert.ok(overviewRows.length >= 3, "Expected multiple overview audit rows");
    for (const row of overviewRows) {
      assertCompletedNarrative(row["Audit focus"], "reference audit overview focus");
      assertCompletedNarrative(
        row["Reference evidence"],
        "reference audit overview evidence",
      );
      assertCompletedNarrative(
        row["Implementation consequence"],
        "reference audit overview implementation consequence",
      );
    }

    const sharedPatternRows = parseMarkdownTable(
      notes,
      "## Reference Audit Shared Patterns",
      [...expectedReferenceAuditSharedPatternHeaders],
    );
    assert.equal(
      sharedPatternRows.length,
      expectedSharedPatternGroups.length,
      "Expected the shared-pattern audit to keep the approved five pattern groups",
    );
    for (const patternGroup of expectedSharedPatternGroups) {
      const patternRow = sharedPatternRows.find(
        (row) => row["Pattern group"] === patternGroup,
      );
      assert.ok(patternRow, `Expected shared-pattern row for ${patternGroup}`);
      assertCompletedNarrative(
        patternRow["Observed across references"],
        `${patternGroup} observed pattern`,
      );
      assertCompletedNarrative(
        patternRow["Audit implication for implementation"],
        `${patternGroup} implementation implication`,
      );
    }

    const routeMatrixRows = parseMarkdownTable(
      notes,
      "## Reference Audit Route Matrix",
      [...expectedReferenceAuditRouteMatrixHeaders],
    );
    assert.equal(
      routeMatrixRows.length,
      expectedOmissionRows.length,
      "Expected one route-audit matrix row per in-scope route",
    );

    for (const { route, asset } of expectedOmissionRows) {
      const routeMatrixRow = routeMatrixRows.find((row) => row["Current route"] === route);
      assert.ok(routeMatrixRow, `Expected route-audit matrix row for ${route}`);
      assert.match(
        routeMatrixRow["Reference asset pair"],
        new RegExp(`${escapeRegExp(asset)}/code\\.html`),
        `Expected ${route} route-audit row to cite ${asset}/code.html`,
      );
      assert.match(
        routeMatrixRow["Reference asset pair"],
        new RegExp(`${escapeRegExp(asset)}/screen\\.png`),
        `Expected ${route} route-audit row to cite ${asset}/screen.png`,
      );
      assertCompletedNarrative(
        routeMatrixRow["Shared patterns carried forward"],
        `${route} shared patterns carried forward`,
      );
      assertCompletedNarrative(
        routeMatrixRow["Route-unique reference pattern"],
        `${route} route-unique reference pattern`,
      );
      assertCompletedNarrative(
        routeMatrixRow["Truthful substitutions required"],
        `${route} truthful substitutions required`,
      );
      assertCompletedNarrative(
        routeMatrixRow["Mock-only elements to omit"],
        `${route} mock-only elements to omit`,
      );
    }

    const residualDeltaRows = parseMarkdownTable(
      notes,
      "## Reference Audit Residual Delta Log",
      [...expectedReferenceAuditResidualDeltaHeaders],
    );
    assert.equal(
      residualDeltaRows.length,
      expectedOmissionRows.length,
      "Expected one residual-delta row per in-scope route",
    );

    for (const { route } of expectedOmissionRows) {
      const residualDeltaRow = residualDeltaRows.find(
        (row) => row["Current route"] === route,
      );
      assert.ok(residualDeltaRow, `Expected residual-delta row for ${route}`);
      assertCompletedNarrative(residualDeltaRow["Audit pass"], `${route} audit pass`);
      assertCompletedNarrative(
        residualDeltaRow["Highest-value unresolved fidelity delta"],
        `${route} unresolved fidelity delta`,
      );
      assertCompletedNarrative(
        residualDeltaRow["Truthful constraint to preserve"],
        `${route} truthful constraint`,
      );
      assertCompletedNarrative(
        residualDeltaRow["Next implementation target"],
        `${route} next implementation target`,
      );
    }
  },
);

test(
  "implementation notes keep parser-sensitive route headings inside the fidelity review ledger only",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const fidelityLedgerSection = extractTopLevelSection(notes, "## Fidelity Review Ledger");
    const routeHeadingMatches = [
      ...notes.matchAll(/^### `\/[^`]*`$/gm),
    ].map((match) => match[0]);

    // Assert
    assert.deepEqual(
      routeHeadingMatches,
      requiredReviewRoutes.map((route) => `### \`${route}\``),
      "Expected the notes file to keep exactly the seven approved route headings",
    );

    const notesOutsideFidelityLedger = notes.replace(fidelityLedgerSection, "");
    assert.doesNotMatch(
      notesOutsideFidelityLedger,
      /^### `\/[^`]*`$/m,
      "Expected route-level ### headings to remain confined to the fidelity review ledger",
    );
  },
);

test(
  "web http delegates environment, review, and agent detail markup to dedicated page modules",
  async () => {
    // Arrange
    const environmentManagementPagePath = path.join(
      repositoryRoot,
      "apps",
      "web",
      "src",
      "ui",
      "pages",
      "environment-management.ts",
    );
    const reviewQueuePagePath = path.join(
      repositoryRoot,
      "apps",
      "web",
      "src",
      "ui",
      "pages",
      "review-queue.ts",
    );
    const agentDetailPagePath = path.join(
      repositoryRoot,
      "apps",
      "web",
      "src",
      "ui",
      "pages",
      "agent-detail.ts",
    );
    const webHttpPath = path.join(repositoryRoot, "apps", "web", "src", "http.ts");

    // Act
    await Promise.all([
      access(environmentManagementPagePath),
      access(reviewQueuePagePath),
      access(agentDetailPagePath),
    ]);
    const webHttpSource = await readFile(webHttpPath, "utf8");

    // Assert
    for (const importPath of [
      "./ui/pages/sign-in.js",
      "./ui/pages/dashboard.js",
      "./ui/pages/environment-management.js",
      "./ui/pages/draft-registration.js",
      "./ui/pages/review-queue.js",
      "./ui/pages/agent-detail.js",
      "./ui/pages/version-detail.js",
    ]) {
      assert.match(
        webHttpSource,
        new RegExp(`from "${escapeRegExp(importPath)}"`),
        `Expected http.ts to import ${importPath}`,
      );
    }

    assert.match(webHttpSource, /renderEnvironmentManagementPage\(/);
    assert.match(webHttpSource, /renderReviewQueuePage\(/);
    assert.match(webHttpSource, /renderAgentDetailPage\(/);
    assert.doesNotMatch(webHttpSource, /data-environment-panel="inventory"/);
    assert.doesNotMatch(webHttpSource, /class="review-queue-item card"/);
    assert.doesNotMatch(webHttpSource, /agent-detail-overlay-card stack/);
  },
);

test(
  "approved visual baselines are committed under tests/visual/__screenshots__ for every route and viewport",
  async () => {
    // Arrange
    let fileNames: string[] = [];

    // Act
    try {
      fileNames = await readdir(screenshotDirectory);
    } catch (error) {
      assert.fail(
        `Expected committed screenshot baselines in ${screenshotDirectory}: ${String(error)}`,
      );
    }

    // Assert
    assert.deepEqual([...fileNames].sort(), [...expectedScreenshots].sort());
  },
);

test(
  "implementation notes retain completed sign-off metadata and route-by-route fidelity sections",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const signOffSection = extractSection(notes, "## Sign-Off Record");

    // Assert
    assert.doesNotMatch(notes, /_TBD_/);

    for (const field of requiredSignOffNarrativeFields) {
      const value = extractBulletValue(signOffSection, field);
      assertCompletedNarrative(value, `sign-off ${field}`);
    }

    const reviewDate = extractBulletValue(signOffSection, "Review date");
    assert.match(reviewDate, /\b\d{4}-\d{2}-\d{2}\b/, "Expected review date to include YYYY-MM-DD");
    assert.match(reviewDate, /\bUTC\b/, "Expected review date to include UTC");

    const baselineSet = extractBulletValue(signOffSection, "Baseline set");
    assert.match(
      baselineSet,
      /tests\/visual\/__screenshots__\//,
      "Expected baseline set to point at the committed screenshot directory",
    );
    assert.match(
      baselineSet,
      /1440x1200/,
      "Expected baseline set to document the approved desktop viewport",
    );
    assert.match(
      baselineSet,
      /390x844/,
      "Expected baseline set to document the approved mobile viewport",
    );

    for (const field of requiredSignOffStatusFields) {
      const value = extractBulletValue(signOffSection, field);
      assert.equal(value, "Complete", `Expected ${field} to be marked Complete`);
    }

    for (const route of requiredReviewRoutes) {
      const routeHeading = `### \`${route}\``;
      const routeSection = extractSection(notes, routeHeading);
      const mappedReference = expectedOmissionRows.find((row) => row.route === route);

      assert.match(notes, new RegExp(`^${escapeRegExp(routeHeading)}$`, "m"));
      assert.ok(mappedReference, `Expected mapped reference asset for ${route}`);

      for (const field of requiredRouteSupportFields) {
        const value = extractBulletValue(routeSection, field);
        assertCompletedNarrative(value, `${routeHeading} ${field}`);
      }

      const referenceAssets = extractBulletValue(routeSection, "Reference assets");
      assert.match(
        referenceAssets,
        new RegExp(`${escapeRegExp(mappedReference.asset)}/code\\.html`),
        `Expected ${routeHeading} to cite ${mappedReference.asset}/code.html`,
      );
      assert.match(
        referenceAssets,
        new RegExp(`${escapeRegExp(mappedReference.asset)}/screen\\.png`),
        `Expected ${routeHeading} to cite ${mappedReference.asset}/screen.png`,
      );

      const reviewEvidence = extractBulletValue(routeSection, "Review evidence");
      assert.match(
        reviewEvidence,
        /code\.html/,
        `Expected ${routeHeading} review evidence to mention code.html`,
      );
      assert.match(
        reviewEvidence,
        /screen\.png/,
        `Expected ${routeHeading} review evidence to mention screen.png`,
      );
      assert.match(
        reviewEvidence,
        /\b\d{4}-\d{2}-\d{2}\b/,
        `Expected ${routeHeading} review evidence to include the review date`,
      );

      for (const field of requiredReviewFields) {
        const value = extractBulletValue(routeSection, field);
        assertCompletedNarrative(value, `${routeHeading} ${field}`);
      }
    }
  },
);

test(
  "implementation notes include a completed omissions and truthful substitutions row for each in-scope route",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const omissionRows = parseMarkdownTable(notes, "## Omissions and Truthful Substitutions", [
      "Route",
      "Reference asset",
      "Mock-only content or unsupported control",
      "Truthful implementation replacement or omission",
      "Reason",
    ]);

    // Assert
    assert.equal(
      omissionRows.length,
      expectedOmissionRows.length,
      "Expected one omission or truthful-substitution row per in-scope route",
    );

    for (const { route, asset } of expectedOmissionRows) {
      const omissionRow = omissionRows.find(
        (row) => row.Route === route && row["Reference asset"] === asset,
      );

      assert.ok(
        omissionRow,
        `Expected omissions table row for ${route} mapped to ${asset}`,
      );
      assertCompletedNarrative(
        omissionRow["Mock-only content or unsupported control"],
        `${route} mock-only content`,
      );
      assertCompletedNarrative(
        omissionRow["Truthful implementation replacement or omission"],
        `${route} truthful replacement`,
      );
      assertCompletedNarrative(omissionRow.Reason, `${route} deviation reason`);
    }
  },
);

test(
  "implementation notes include the completed DESIGN.md checklist rows required for sign-off",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const checklistRows = parseMarkdownTable(notes, "## DESIGN.md Checklist", [
      "Checklist item",
      "Status",
      "Review note",
    ]);

    // Assert
    assert.equal(
      checklistRows.length,
      expectedChecklistItems.length,
      "Expected a completed checklist row for each DESIGN.md review item",
    );

    for (const checklistItem of expectedChecklistItems) {
      const checklistRow = checklistRows.find(
        (row) => row["Checklist item"] === checklistItem,
      );

      assert.ok(checklistRow, `Expected checklist row for ${checklistItem}`);
      assert.equal(
        checklistRow.Status,
        "Complete",
        `Expected checklist item ${checklistItem} to be marked Complete`,
      );
      assertCompletedNarrative(
        checklistRow["Review note"],
        `${checklistItem} review note`,
      );
    }
  },
);

test(
  "implementation notes include completed non-placeholder version-detail deviation entries",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const deviationRows = parseMarkdownTable(notes, "## Version Detail Deviation Table", [
      "Reference mock detail",
      "Truthful implementation replacement",
      "Reason for deviation",
    ]);

    // Assert
    assert.equal(
      deviationRows.length,
      expectedVersionDetailDeviations.length,
      "Expected the approved version-detail deviations to remain fully documented",
    );

    for (const referenceDetail of expectedVersionDetailDeviations) {
      const deviationRow = deviationRows.find(
        (row) => row["Reference mock detail"] === referenceDetail,
      );

      assert.ok(
        deviationRow,
        `Expected version-detail deviation row for ${referenceDetail}`,
      );
      assertCompletedNarrative(
        deviationRow["Truthful implementation replacement"],
        `${referenceDetail} truthful replacement`,
      );
      assertCompletedNarrative(
        deviationRow["Reason for deviation"],
        `${referenceDetail} deviation reason`,
      );
    }
  },
);
