import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './test',
    testMatch: /.*\.browser\.spec\.ts$/,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    reporter: 'list',
    use: {
        baseURL: 'http://localhost:4173',
    },
    webServer: {
        command: 'npx sirv-cli . --port 4173 --quiet',
        url: 'http://localhost:4173/test/browser-smoke.html',
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
