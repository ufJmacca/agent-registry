import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
    },
  },
  outputDir: "./tests/visual/.artifacts",
  testDir: "./tests/visual",
  workers: 1,
  use: {
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        browserName: "chromium",
        viewport: {
          height: 1200,
          width: 1440,
        },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        browserName: "chromium",
        viewport: {
          height: 844,
          width: 390,
        },
      },
    },
  ],
});
