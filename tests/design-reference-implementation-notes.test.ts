import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const implementationNotesPath = fileURLToPath(
  new URL("../design-reference/IMPLEMENTATION_NOTES.md", import.meta.url),
);
const repositoryRoot = dirname(dirname(implementationNotesPath));
const implementationNotesRepoPath = relative(repositoryRoot, implementationNotesPath);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("IMPLEMENTATION_NOTES is resolved from this checkout and tracked by git in this checkout", async () => {
  // Arrange: target the branch-local notes artifact that this slice is supposed to protect.
  const expectedRepoPath = "design-reference/IMPLEMENTATION_NOTES.md";

  // Act: ask git in this checkout whether the notes file is a tracked path.
  const trackedPath = await execFileAsync(
    "git",
    ["ls-files", "--error-unmatch", implementationNotesRepoPath],
    { cwd: repositoryRoot },
  );

  // Assert: the test points at the repo-local artifact and git knows about that exact file.
  assert.equal(implementationNotesRepoPath, expectedRepoPath);
  assert.equal(trackedPath.stdout.trim(), expectedRepoPath);
});

test("IMPLEMENTATION_NOTES maps every current console route to its approved reference and reserves fidelity review space", async () => {
  // Arrange: capture the approved route-to-reference matrix from the PRD for this slice.
  const requiredMappings = [
    { route: "/", reference: "sign_in_landing_page" },
    { route: "/console", reference: "console_dashboard" },
    { route: "/tenants/:tenantId/environments", reference: "environment_management" },
    { route: "/tenants/:tenantId/drafts/new", reference: "new_draft_registration" },
    { route: "/tenants/:tenantId/review", reference: "review_queue" },
    { route: "/tenants/:tenantId/agents/:agentId", reference: "active_agent_detail" },
    {
      route: "/tenants/:tenantId/agents/:agentId/versions/:versionId",
      reference: "version_detail",
    },
  ];

  // Act: load the implementation-notes scaffold that the UI refactor work will follow.
  const notes = await readFile(implementationNotesPath, "utf8");

  // Assert: every route is mapped to the approved reference and gets a placeholder fidelity section.
  for (const mapping of requiredMappings) {
    assert.match(
      notes,
      new RegExp(
        `\\|\\s*\`${escapeRegExp(mapping.route)}\`\\s*\\|\\s*\`${escapeRegExp(mapping.reference)}\`\\s*\\|`,
      ),
    );
    assert.match(notes, new RegExp(`###\\s+\`${escapeRegExp(mapping.route)}\``));
  }

  assert.match(notes, /dedicated `version_detail` reference/i);
});

test("IMPLEMENTATION_NOTES records omission rules, DESIGN.md review checks, and a version_detail deviation table", async () => {
  // Arrange: define the contract sections and policy language that must exist before page work starts.
  const requiredHeadings = [
    "## Omissions and Truthful Substitutions",
    "## DESIGN.md Checklist",
    "## Fidelity Review Ledger",
    "## Version Detail Deviation Table",
  ];

  // Act: load the scaffold content.
  const notes = await readFile(implementationNotesPath, "utf8");

  // Assert: the notes include the required sections and the explicit no-inert-controls rule.
  for (const heading of requiredHeadings) {
    assert.match(notes, new RegExp(`^${escapeRegExp(heading)}$`, "m"));
  }

  assert.match(notes, /unsupported mock controls must be omitted rather than rendered inert/i);
  assert.match(notes, /\bNo-Line Rule\b/);
  assert.match(notes, /gradient primary CTAs/i);
  assert.match(notes, /Manrope/i);
  assert.match(notes, /\bInter\b/);
  assert.match(notes, /glassmorphism only.*floating shells/i);
  assert.match(
    notes,
    /\|\s*Reference mock detail\s*\|\s*Truthful implementation replacement\s*\|\s*Reason for deviation\s*\|/i,
  );
});
