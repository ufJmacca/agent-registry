import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listPngFiles(directoryPath: string): Promise<string[]> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directoryPath, entry.name);

      if (entry.isDirectory()) {
        return listPngFiles(entryPath);
      }

      return entry.isFile() && entry.name.endsWith(".png") ? [entryPath] : [];
    }),
  );

  return files.flat().sort();
}

test("visual regression wiring runs through the existing npm test path and bootstrap flow", async () => {
  // Arrange
  const packageSource = await readRepositoryFile("package.json");
  const dockerfileSource = await readRepositoryFile("Dockerfile.workspace");
  const bootstrapSource = await readRepositoryFile("scripts/bootstrap.sh");
  const packageJson = JSON.parse(packageSource) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  // Act
  const scripts = packageJson.scripts ?? {};
  const devDependencies = packageJson.devDependencies ?? {};

  // Assert
  assert.equal(scripts["test:visual"], "playwright test");
  assert.match(scripts.test ?? "", /\bnpm run test:visual\b/);
  assert.match(scripts["test:inner"] ?? "", /\bnpm run test:visual\b/);
  assert.equal(typeof devDependencies["@playwright/test"], "string");
  assert.match(dockerfileSource, /\blibgbm1\b/);
  assert.match(dockerfileSource, /\blibnss3\b/);
  assert.match(bootstrapSource, /playwright install chromium/);
});

test("visual regression assets cover the agreed viewport matrix and committed baselines", async () => {
  // Arrange
  const playwrightConfigPath = path.join(repositoryRoot, "playwright.config.ts");
  const visualSpecPath = path.join(repositoryRoot, "tests", "visual", "web-console.visual.spec.ts");
  const supportFixturePath = path.join(
    repositoryRoot,
    "tests",
    "support",
    "web-console-fixtures.ts",
  );
  const snapshotsRoot = path.join(repositoryRoot, "tests", "visual");

  // Act
  await access(playwrightConfigPath);
  await access(visualSpecPath);
  await access(supportFixturePath);
  const playwrightConfigSource = await readFile(playwrightConfigPath, "utf8");
  const visualSpecSource = await readFile(visualSpecPath, "utf8");
  const supportFixtureSource = await readFile(supportFixturePath, "utf8");
  const pngFiles = await listPngFiles(snapshotsRoot);

  // Assert
  assert.match(playwrightConfigSource, /name:\s*"desktop"/);
  assert.match(playwrightConfigSource, /name:\s*"mobile"/);
  assert.match(playwrightConfigSource, /width:\s*1440/);
  assert.match(playwrightConfigSource, /height:\s*1200/);
  assert.match(playwrightConfigSource, /width:\s*390/);
  assert.match(playwrightConfigSource, /height:\s*844/);
  assert.match(visualSpecSource, /waitForVisualReadiness/);
  assert.match(supportFixtureSource, /document\.fonts\.ready/);
  assert.match(visualSpecSource, /animations:\s*"disabled"/);
  assert.match(visualSpecSource, /mask:\s*buildMask/);
  assert.equal(pngFiles.length, 14);
});

test("implementation notes record every page review and the final version-detail deviations", async () => {
  // Arrange
  const notesSource = await readRepositoryFile("design-reference/IMPLEMENTATION_NOTES.md");
  const routeReviewFields = [
    "Shell composition and overall layout",
    "Headline scale and spacing",
    "Card and background layering",
    "Navigation treatment",
    "Information density and grouping",
    "Functional constraints to preserve",
    "Intentional deviations and truthful substitutions",
  ];
  const routes = [
    "/",
    "/console",
    "/tenants/:tenantId/environments",
    "/tenants/:tenantId/drafts/new",
    "/tenants/:tenantId/review",
    "/tenants/:tenantId/agents/:agentId",
    "/tenants/:tenantId/agents/:agentId/versions/:versionId",
  ];

  // Act
  const versionDetailRows = notesSource.match(/^\| .+ \| .+ \| .+ \|$/gm) ?? [];

  // Assert
  assert.doesNotMatch(notesSource, /_TBD_/);

  for (const route of routes) {
    assert.match(notesSource, new RegExp(`### \`${escapeRegExp(route)}\``));
  }

  for (const field of routeReviewFields) {
    assert.doesNotMatch(
      notesSource,
      new RegExp(`- ${escapeRegExp(field)}:\\s*$`, "m"),
    );
  }

  assert.ok(versionDetailRows.length >= 3);
});
