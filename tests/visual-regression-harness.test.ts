import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = process.cwd();

function createBehavioralSmokeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  delete env.FORCE_COLOR;
  delete env.NO_COLOR;

  return env;
}

async function runRepositoryCommand(command: string, args: string[]): Promise<{
  stderr: string;
  stdout: string;
}> {
  return execFileAsync(command, args, {
    cwd: repositoryRoot,
    env: createBehavioralSmokeEnv(),
    maxBuffer: 20 * 1024 * 1024,
  });
}

test("root npm scripts fan out to unit and visual regression suites", async () => {
  // Arrange
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  // Act
  const scripts = packageJson.scripts ?? {};

  // Assert
  assert.equal(packageJson.devDependencies?.["@playwright/test"], "^1.58.2");
  assert.equal(scripts["test:unit"], "tsx --test tests/*.test.ts");
  assert.equal(scripts["test:visual"], "playwright test");
  assert.equal(scripts["test:visual:update"], "playwright test --update-snapshots");
  assert.match(scripts.test ?? "", /workspace-foundation\.test\.sh --mode=outer/);
  assert.match(scripts.test ?? "", /npm run test:unit/);
  assert.match(scripts.test ?? "", /npm run test:visual/);
  assert.match(scripts["test:inner"] ?? "", /workspace-foundation\.test\.sh --mode=inner/);
  assert.match(scripts["test:inner"] ?? "", /npm run test:unit/);
  assert.match(scripts["test:inner"] ?? "", /npm run test:visual/);
});

test("playwright visual regression is pinned to chromium desktop and mobile baselines", async () => {
  // Arrange
  const configModule = (await import(
    pathToFileURL(path.join(repositoryRoot, "playwright.config.ts")).href
  )) as {
    default: {
      expect?: {
        toHaveScreenshot?: {
          maxDiffPixelRatio?: number;
        };
      };
      projects?: Array<{
        name?: string;
        use?: {
          browserName?: string;
          viewport?: {
            height?: number;
            width?: number;
          };
        };
      }>;
      testDir?: string;
    };
  };

  // Act
  const config = configModule.default;
  const projects = config.projects ?? [];

  // Assert
  assert.equal(config.testDir, "./tests/visual");
  assert.equal(config.expect?.toHaveScreenshot?.maxDiffPixelRatio, 0.01);
  assert.deepEqual(
    projects.map((project) => ({
      browserName: project.use?.browserName,
      name: project.name,
      viewport: project.use?.viewport,
    })),
    [
      {
        browserName: "chromium",
        name: "chromium-desktop",
        viewport: {
          height: 1200,
          width: 1440,
        },
      },
      {
        browserName: "chromium",
        name: "chromium-mobile",
        viewport: {
          height: 844,
          width: 390,
        },
      },
    ],
  );
});

test("bootstrap script and container images declare the playwright runtime contract", async () => {
  // Arrange
  const [bootstrapScript, workspaceDockerfile, devcontainerDockerfile] = await Promise.all([
    readFile(path.join(repositoryRoot, "scripts", "bootstrap.sh"), "utf8"),
    readFile(path.join(repositoryRoot, "Dockerfile.workspace"), "utf8"),
    readFile(path.join(repositoryRoot, ".devcontainer", "Dockerfile"), "utf8"),
  ]);

  // Act
  const requiredRuntimePatterns = [
    /\blibasound2(t64)?\b/,
    /\blibgbm1\b/,
    /\blibnss3\b/,
    /\blibxkbcommon0\b/,
  ];

  // Assert
  assert.match(bootstrapScript, /npx playwright install chromium/);

  for (const dockerfile of [workspaceDockerfile, devcontainerDockerfile]) {
    for (const packagePattern of requiredRuntimePatterns) {
      assert.match(dockerfile, packagePattern);
    }
  }
});

test(
  "bootstrap and the root visual entry point launch a Chromium smoke run",
  { timeout: 120_000 },
  async () => {
    // Arrange
    const visualSmokeArgs = [
      "run",
      "test:visual",
      "--",
      "tests/visual/web-console.visual.spec.ts",
      "--grep",
      "matches sign-in-landing",
      "--project=chromium-desktop",
      "--workers=1",
      "--reporter=list",
    ];

    // Act
    await runRepositoryCommand("bash", ["./scripts/bootstrap.sh"]);
    const { stderr, stdout } = await runRepositoryCommand("npm", visualSmokeArgs);
    const combinedOutput = `${stdout}\n${stderr}`;

    // Assert
    assert.match(combinedOutput, /matches sign-in-landing/);
    assert.match(combinedOutput, /\b1 passed\b/);
  },
);
