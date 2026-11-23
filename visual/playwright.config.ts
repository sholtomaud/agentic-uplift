/**
 * Visual snapshot config. Runs only inside the pinned Playwright container
 * (see .github/workflows/visual.yml and visual/run.sh) so font rendering
 * matches the committed baselines.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  snapshotPathTemplate: '{testDir}/../snapshots/{arg}{ext}',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'report' }]],
  outputDir: './test-results',
  expect: {
    toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixelRatio: 0.002 },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'en-US',
    timezoneId: 'UTC',
    deviceScaleFactor: 1,
  },
  webServer: {
    command: 'node src/cli.ts serve --dir visual/.site --port 4173',
    cwd: '..',
    url: 'http://127.0.0.1:4173/data/status.json',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
