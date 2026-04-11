import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'npm run start:dashboard -- --port=3000',
    url: 'http://127.0.0.1:3000/',
    timeout: 120_000,
    reuseExistingServer: true,
    env: {
      ...process.env,
      SYMPHONY_OFFLINE: '1',
      SYMPHONY_PORT: '3000'
    }
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
