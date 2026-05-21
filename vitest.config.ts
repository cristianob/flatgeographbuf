import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Playwright tests live under `test/*.browser.spec.ts` and are
        // run via `pnpm test:browser` — vitest must not pick them up
        // (their imports come from @playwright/test, not vitest).
        exclude: ['**/node_modules/**', '**/*.browser.spec.ts'],
    },
});
