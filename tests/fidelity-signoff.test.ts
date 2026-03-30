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
  "implementation notes record the / sign-in fidelity pass and public-shell truthful substitutions",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const signInSection = extractSection(notes, "### `/`");
    const residualDeltaRows = parseMarkdownTable(
      notes,
      "## Reference Audit Residual Delta Log",
      [...expectedReferenceAuditResidualDeltaHeaders],
    );
    const omissionRows = parseMarkdownTable(notes, "## Omissions and Truthful Substitutions", [
      "Route",
      "Reference asset",
      "Mock-only content or unsupported control",
      "Truthful implementation replacement or omission",
      "Reason",
    ]);
    const signInResidualDeltaRow = residualDeltaRows.find(
      (row) => row["Current route"] === "/",
    );
    const signInOmissionRow = omissionRows.find(
      (row) => row.Route === "/" && row["Reference asset"] === "sign_in_landing_page",
    );

    // Assert
    assert.ok(signInResidualDeltaRow, "Expected a residual-delta row for /");
    assert.match(
      signInResidualDeltaRow["Audit pass"],
      /Public sign-in fidelity pass completed on \d{4}-\d{2}-\d{2} UTC\./,
      "Expected / to record the completed sign-in fidelity pass",
    );
    assert.doesNotMatch(
      signInResidualDeltaRow["Audit pass"],
      /Phase 0 reference audit/i,
      "Expected / to move beyond the Phase 0 audit state",
    );
    assert.match(
      signInResidualDeltaRow["Highest-value unresolved fidelity delta"],
      /extra marketing destinations.*intentionally absent/i,
      "Expected / residual delta to capture the intentionally omitted mock marketing controls",
    );
    assert.match(
      signInResidualDeltaRow["Truthful constraint to preserve"],
      /signed-in redirect behavior.*tenant-aware selection.*self-hosted collapse.*setup-pending prominence/i,
      "Expected / residual delta to preserve the real sign-in flow constraints",
    );

    assert.ok(
      signInOmissionRow,
      "Expected an omissions and truthful substitutions row for /",
    );
    assert.match(
      signInOmissionRow["Mock-only content or unsupported control"],
      /SSO login.*biometrics.*marketing navigation links/i,
      "Expected / omissions row to list the unsupported mock auth and marketing controls",
    );
    assert.match(
      signInOmissionRow["Truthful implementation replacement or omission"],
      /tenant selector.*subject selector.*\/session.*\/console/i,
      "Expected / omissions row to document the truthful sign-in controls and routed destination",
    );

    const navigationTreatment = extractBulletValue(signInSection, "Navigation treatment");
    assert.match(
      navigationTreatment,
      /extra marketing links were intentionally omitted/i,
      "Expected / review notes to record the omitted mock navigation controls",
    );
    assert.match(
      navigationTreatment,
      /truthful in-page anchors.*\/console/i,
      "Expected / review notes to document the truthful public-shell navigation replacements",
    );

    const intentionalDeviations = extractBulletValue(
      signInSection,
      "Intentional deviations and truthful substitutions",
    );
    assert.match(
      intentionalDeviations,
      /tenant-membership sign-in flow/i,
      "Expected / review notes to cite the truthful membership-based sign-in flow",
    );
    assert.match(
      intentionalDeviations,
      /truthful in-page sections and `?\/console`?/i,
      "Expected / review notes to keep the public-shell link substitutions explicit",
    );
  },
);

test(
  "implementation notes record the /console dashboard fidelity pass, truthful substitutions, and remaining deltas",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const consoleSection = extractSection(notes, "### `/console`");
    const residualDeltaRows = parseMarkdownTable(
      notes,
      "## Reference Audit Residual Delta Log",
      [...expectedReferenceAuditResidualDeltaHeaders],
    );
    const omissionRows = parseMarkdownTable(notes, "## Omissions and Truthful Substitutions", [
      "Route",
      "Reference asset",
      "Mock-only content or unsupported control",
      "Truthful implementation replacement or omission",
      "Reason",
    ]);
    const consoleResidualDeltaRow = residualDeltaRows.find(
      (row) => row["Current route"] === "/console",
    );
    const consoleOmissionRow = omissionRows.find(
      (row) => row.Route === "/console" && row["Reference asset"] === "console_dashboard",
    );

    // Assert
    assert.ok(consoleResidualDeltaRow, "Expected a residual-delta row for /console");
    assert.match(
      consoleResidualDeltaRow["Audit pass"],
      /Dashboard fidelity pass completed on \d{4}-\d{2}-\d{2} UTC\./,
      "Expected /console to record the completed dashboard fidelity pass",
    );
    assert.doesNotMatch(
      consoleResidualDeltaRow["Audit pass"],
      /Phase 0 reference audit/i,
      "Expected /console to move beyond the Phase 0 audit state",
    );
    assert.match(
      consoleResidualDeltaRow["Highest-value unresolved fidelity delta"],
      /recent-activity strip.*profile portrait.*intentionally absent/i,
      "Expected /console residual delta to capture the intentionally omitted mock activity and portrait elements",
    );
    assert.match(
      consoleResidualDeltaRow["Truthful constraint to preserve"],
      /role-sensitive navigation.*publisher-versus-admin visibility rules.*version or active-agent counts/i,
      "Expected /console residual delta to preserve truthful role gating and dashboard counts",
    );
    assert.match(
      consoleResidualDeltaRow["Next implementation target"],
      /shell spacing/i,
      "Expected /console residual delta to keep the remaining shell-spacing follow-up explicit",
    );

    assert.ok(
      consoleOmissionRow,
      "Expected an omissions and truthful substitutions row for /console",
    );
    assert.match(
      consoleOmissionRow["Mock-only content or unsupported control"],
      /Synthetic activity feed.*utilization gauges.*profile portrait media.*settings-style destinations/i,
      "Expected /console omissions row to list the unsupported mock dashboard analytics and destinations",
    );
    assert.match(
      consoleOmissionRow["Truthful implementation replacement or omission"],
      /Signed-in identity.*tenant context.*draft-registration feature card.*role-sensitive workspace actions.*visible versions.*admin-only active agents/i,
      "Expected /console omissions row to document the truthful dashboard replacements",
    );

    const informationDensity = extractBulletValue(consoleSection, "Information density and grouping");
    assert.match(
      informationDensity,
      /Signed-in identity.*tenant context.*workspace actions.*visible versions.*admin-only active agents/i,
      "Expected /console review notes to map truthful dashboard regions into the new layout",
    );

    const functionalConstraints = extractBulletValue(
      consoleSection,
      "Functional constraints to preserve",
    );
    assert.match(
      functionalConstraints,
      /role-sensitive entry points.*publishers do not see admin-only controls.*draft registration.*review.*environments.*active agents.*version detail/i,
      "Expected /console review notes to keep the dashboard's role-sensitive route access explicit",
    );

    const intentionalDeviations = extractBulletValue(
      consoleSection,
      "Intentional deviations and truthful substitutions",
    );
    assert.match(
      intentionalDeviations,
      /Synthetic activity rows.*utilization gauges.*urgent-count badges.*profile portrait media/i,
      "Expected /console review notes to cite the omitted mock dashboard-only controls",
    );
    assert.match(
      intentionalDeviations,
      /truthful counts.*route links.*active-agent inventory/i,
      "Expected /console review notes to document the truthful dashboard replacements",
    );
  },
);

test(
  "implementation notes record the /tenants/:tenantId/drafts/new fidelity pass, truthful substitutions, and remaining deltas",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const draftRegistrationSection = extractSection(
      notes,
      "### `/tenants/:tenantId/drafts/new`",
    );
    const residualDeltaRows = parseMarkdownTable(
      notes,
      "## Reference Audit Residual Delta Log",
      [...expectedReferenceAuditResidualDeltaHeaders],
    );
    const omissionRows = parseMarkdownTable(notes, "## Omissions and Truthful Substitutions", [
      "Route",
      "Reference asset",
      "Mock-only content or unsupported control",
      "Truthful implementation replacement or omission",
      "Reason",
    ]);
    const draftRegistrationResidualDeltaRow = residualDeltaRows.find(
      (row) => row["Current route"] === "/tenants/:tenantId/drafts/new",
    );
    const draftRegistrationOmissionRow = omissionRows.find(
      (row) =>
        row.Route === "/tenants/:tenantId/drafts/new" &&
        row["Reference asset"] === "new_draft_registration",
    );

    // Assert
    assert.ok(
      draftRegistrationResidualDeltaRow,
      "Expected a residual-delta row for /tenants/:tenantId/drafts/new",
    );
    assert.match(
      draftRegistrationResidualDeltaRow["Audit pass"],
      /Draft-registration fidelity pass completed on \d{4}-\d{2}-\d{2} UTC\./,
      "Expected /tenants/:tenantId/drafts/new to record the completed draft-registration fidelity pass",
    );
    assert.doesNotMatch(
      draftRegistrationResidualDeltaRow["Audit pass"],
      /Phase 0 reference audit/i,
      "Expected /tenants/:tenantId/drafts/new to move beyond the Phase 0 audit state",
    );
    assert.match(
      draftRegistrationResidualDeltaRow["Highest-value unresolved fidelity delta"],
      /hero, upper grid, and footer.*widest desktop breakpoint/i,
      "Expected /tenants/:tenantId/drafts/new residual delta to document the remaining screenshot-level spacing polish",
    );
    assert.match(
      draftRegistrationResidualDeltaRow["Truthful constraint to preserve"],
      /every current field name.*multipart behavior.*publisher restriction.*create-draft submission path.*truthful no-environments state.*no fake publication controls/i,
      "Expected /tenants/:tenantId/drafts/new residual delta to preserve the draft route's truthful form and empty-state constraints",
    );
    assert.match(
      draftRegistrationResidualDeltaRow["Next implementation target"],
      /hero-to-panel.*mobile footer spacing/i,
      "Expected /tenants/:tenantId/drafts/new residual delta to keep the remaining spacing follow-up explicit",
    );

    assert.ok(
      draftRegistrationOmissionRow,
      "Expected an omissions and truthful substitutions row for /tenants/:tenantId/drafts/new",
    );
    assert.match(
      draftRegistrationOmissionRow["Mock-only content or unsupported control"],
      /Model picker.*autosave messaging.*save-as-draft.*submit-for-review footer actions/i,
      "Expected /tenants/:tenantId/drafts/new omissions row to list the unsupported mock workflow controls",
    );
    assert.match(
      draftRegistrationOmissionRow["Truthful implementation replacement or omission"],
      /Real draft metadata fields.*shared contract JSON textareas.*per-environment multipart publication panels.*truthful no-environments empty state.*single create-draft submit action/i,
      "Expected /tenants/:tenantId/drafts/new omissions row to document the truthful draft workflow replacements",
    );

    const ctaTreatment = extractBulletValue(
      draftRegistrationSection,
      "CTA treatment and hierarchy",
    );
    assert.match(
      ctaTreatment,
      /single gradient Create Draft action/i,
      "Expected /tenants/:tenantId/drafts/new review notes to keep the single draft-creation CTA explicit",
    );
    assert.match(
      ctaTreatment,
      /review submission remains deferred to version detail/i,
      "Expected /tenants/:tenantId/drafts/new review notes to document the truthful create-then-review workflow",
    );

    const functionalConstraints = extractBulletValue(
      draftRegistrationSection,
      "Functional constraints to preserve",
    );
    assert.match(
      functionalConstraints,
      /All existing field names.*multipart uploads.*POST target.*publisher permissions.*data-visual-dynamic="publication-sections".*per-environment publication semantics/i,
      "Expected /tenants/:tenantId/drafts/new review notes to preserve the current multipart contract and visual masking hook",
    );

    const intentionalDeviations = extractBulletValue(
      draftRegistrationSection,
      "Intentional deviations and truthful substitutions",
    );
    assert.match(
      intentionalDeviations,
      /Mock model selection.*autosave language.*save\/submit dual actions/i,
      "Expected /tenants/:tenantId/drafts/new review notes to cite the omitted mock workflow affordances",
    );
    assert.match(
      intentionalDeviations,
      /create-then-review workflow.*truthful empty state.*disabled publication controls/i,
      "Expected /tenants/:tenantId/drafts/new review notes to document the truthful workflow and no-environments substitution",
    );
  },
);

test(
  "implementation notes record the /tenants/:tenantId/review fidelity pass, truthful substitutions, and remaining deltas",
  async () => {
    // Arrange
    const implementationNotesPath = path.join(
      repositoryRoot,
      "design-reference",
      "IMPLEMENTATION_NOTES.md",
    );

    // Act
    const notes = await readFile(implementationNotesPath, "utf8");
    const reviewQueueSection = extractSection(notes, "### `/tenants/:tenantId/review`");
    const residualDeltaRows = parseMarkdownTable(
      notes,
      "## Reference Audit Residual Delta Log",
      [...expectedReferenceAuditResidualDeltaHeaders],
    );
    const omissionRows = parseMarkdownTable(notes, "## Omissions and Truthful Substitutions", [
      "Route",
      "Reference asset",
      "Mock-only content or unsupported control",
      "Truthful implementation replacement or omission",
      "Reason",
    ]);
    const reviewQueueResidualDeltaRow = residualDeltaRows.find(
      (row) => row["Current route"] === "/tenants/:tenantId/review",
    );
    const reviewQueueOmissionRow = omissionRows.find(
      (row) =>
        row.Route === "/tenants/:tenantId/review" &&
        row["Reference asset"] === "review_queue",
    );

    // Assert
    assert.ok(
      reviewQueueResidualDeltaRow,
      "Expected a residual-delta row for /tenants/:tenantId/review",
    );
    assert.match(
      reviewQueueResidualDeltaRow["Audit pass"],
      /Review queue fidelity pass completed on \d{4}-\d{2}-\d{2} UTC\./,
      "Expected /tenants/:tenantId/review to record the completed review-queue fidelity pass",
    );
    assert.doesNotMatch(
      reviewQueueResidualDeltaRow["Audit pass"],
      /Phase 0 reference audit/i,
      "Expected /tenants/:tenantId/review to move beyond the Phase 0 audit state",
    );
    assert.match(
      reviewQueueResidualDeltaRow["Highest-value unresolved fidelity delta"],
      /richer machine-generated diagnostics.*avatar\/icon treatment/i,
      "Expected /tenants/:tenantId/review residual delta to record the remaining truthful review-queue gap",
    );
    assert.match(
      reviewQueueResidualDeltaRow["Truthful constraint to preserve"],
      /tenant-admin-only access.*approve and reject.*version-detail linking/i,
      "Expected /tenants/:tenantId/review residual delta to preserve admin gating and live decision routing",
    );
    assert.match(
      reviewQueueResidualDeltaRow["Next implementation target"],
      /approved queue composition.*desktop and mobile baselines.*decision-first layout/i,
      "Expected /tenants/:tenantId/review residual delta to keep the remaining review-queue follow-up explicit",
    );

    assert.ok(
      reviewQueueOmissionRow,
      "Expected an omissions and truthful substitutions row for /tenants/:tenantId/review",
    );
    assert.match(
      reviewQueueOmissionRow["Mock-only content or unsupported control"],
      /History tab.*search.*filters.*load-more affordance.*diff tooling/i,
      "Expected /tenants/:tenantId/review omissions row to list the unsupported mock review controls",
    );
    assert.match(
      reviewQueueOmissionRow["Truthful implementation replacement or omission"],
      /pending-review entries.*version detail links.*approve action.*reject reason input.*reject action/i,
      "Expected /tenants/:tenantId/review omissions row to document the truthful review-queue replacements",
    );

    const ctaTreatment = extractBulletValue(reviewQueueSection, "CTA treatment and hierarchy");
    assert.match(
      ctaTreatment,
      /Approve stays the primary gradient action/i,
      "Expected /tenants/:tenantId/review review notes to keep approve as the dominant decision action",
    );
    assert.match(
      ctaTreatment,
      /reject remains visually distinct.*reason input.*version-detail navigation.*same immediate action cluster/i,
      "Expected /tenants/:tenantId/review review notes to document the reject reason field and detail-link action grouping",
    );

    const intentionalDeviations = extractBulletValue(
      reviewQueueSection,
      "Intentional deviations and truthful substitutions",
    );
    assert.match(
      intentionalDeviations,
      /Search, filter, history, load-more, and diff tooling remain omitted/i,
      "Expected /tenants/:tenantId/review review notes to cite the omitted mock queue controls",
    );
    assert.match(
      intentionalDeviations,
      /publisher, submission timestamp, and live version-detail access/i,
      "Expected /tenants/:tenantId/review review notes to document the truthful queue replacements",
    );

    const residualDelta = extractBulletValue(reviewQueueSection, "Residual fidelity delta");
    assert.match(
      residualDelta,
      /richer machine-generated diagnostics.*avatar\/icon treatment/i,
      "Expected /tenants/:tenantId/review review notes to keep the remaining fidelity delta explicit",
    );
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
