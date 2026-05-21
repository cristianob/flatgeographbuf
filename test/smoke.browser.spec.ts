import { expect, test } from '@playwright/test';

/**
 * End-to-end smoke test of the production ESM bundle, running in a
 * real Chromium instance via Playwright. The test loads
 * `test/browser-smoke.html`, which imports `dist/flatgeographbuf-geojson.esm.min.js`
 * and exercises every public method of the library. The page surfaces
 * its progress as a series of lines inside `<pre id="out">`; we wait
 * for the success marker and then assert nothing failed.
 *
 * Run with `pnpm test:browser`. Requires `pnpm build` to have been
 * executed at least once so the bundle exists.
 */
test('production ESM bundle works in real Chromium', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(String(err)));
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/test/browser-smoke.html');

    await expect(page.locator('pre#out')).toContainText('ALL SMOKE TESTS PASSED', {
        timeout: 15_000,
    });

    expect(await page.locator('.fail').count()).toBe(0);
    expect(consoleErrors, `unexpected console errors: ${consoleErrors.join('\n')}`).toEqual([]);

    const summary = await page.locator('pre#out').innerText();
    console.log('--- smoke output ---\n' + summary);
});
