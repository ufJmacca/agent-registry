import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/visual",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: "line",
  retries: 0,
  timeout: 30_000,
  use: {
    headless: true,
    reducedMotion: "reduce",
    trace: "off",
    video: "off",
  },
  workers: 1,
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: {
          width: 1440,
          height: 1200,
        },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 5"],
        viewport: {
          width: 390,
          height: 844,
        },
      },
    },
  ],
});
