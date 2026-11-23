/**
 * Cockpit visual snapshots against the frozen fixture in visual/fixture/data.
 * Desktop (1024) and phone (390), light and dark, with the sticky top bar
 * released so full-page captures are stable.
 */
import { expect, test } from '@playwright/test';

const VIEWPORTS = [
  { name: 'desktop', width: 1024, height: 900 },
  { name: 'phone', width: 390, height: 844 },
] as const;

const SECTIONS = ['#flight-deck', '#economics', '#manual-uplift', '#audit-checks', '#agent-api'] as const;

for (const vp of VIEWPORTS) {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${vp.name} ${scheme}`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, reducedMotion: 'reduce' });

      test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => localStorage.clear());
        await page.goto('/');
        await page.waitForSelector('#economics');
        await page.addStyleTag({ content: '.topbar { position: static !important; } html { scroll-behavior: auto !important; }' });
      });

      test('no horizontal scroll and no console errors', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.reload();
        await page.waitForSelector('#economics');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        expect(errors).toEqual([]);
      });

      for (const section of SECTIONS) {
        test(`section ${section}`, async ({ page }) => {
          const el = page.locator(section);
          await expect(el).toHaveScreenshot(`${vp.name}-${scheme}-${section.slice(1)}.png`);
        });
      }

      test('annunciator panel', async ({ page }) => {
        await expect(page.locator('.annunciator').first()).toHaveScreenshot(`${vp.name}-${scheme}-annunciator.png`);
      });
    });
  }
}
