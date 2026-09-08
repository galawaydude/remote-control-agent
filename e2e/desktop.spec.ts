import { expect, test, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { shots } from './ui.ts';

const project = join(process.env['TETHER_E2E_DIR'] as string, 'desktop');
const shoot = shots('desktop');
const GREETING = 'stub agent ready';

async function box(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found as { x: number; y: number; width: number; height: number };
}

test('past 900px the session rail stays beside the terminal', async ({ page }) => {
  mkdirSync(project, { recursive: true });
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(project);
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.locator('.xterm-rows')).toContainText(GREETING);
  await expect(page.locator('.conv')).toHaveCount(0);

  const rail = page.locator('.workspace > .rail');
  const session = page.locator('.workspace > main.screen');
  const railBox = await box(rail);
  const sessionBox = await box(session);
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(sessionBox.x + 1);
  expect(railBox.height).toBeGreaterThan(400);
  expect(railBox.width).toBeGreaterThanOrEqual(280);
  expect(sessionBox.width).toBeGreaterThan(railBox.width);
  expect(await box(page.locator('.termsheet'))).toEqual(await box(page.locator('.panes')));

  const row = page.getByRole('button', { name: `desktop ${project}` });
  await expect(row).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('button', { name: 'Back to sessions' })).toHaveCount(0);
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(1);
  await shoot(page, '1-rail-beside-the-terminal');

  await page.getByRole('button', { name: 'Hide session sidebar' }).click();
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(0);
  const closed = await box(session);
  expect(closed.x).toBeCloseTo(0, 0);
  expect(closed.width).toBeCloseTo(1280, 0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show session sidebar' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Show session sidebar' }).click();
  await expect(page.getByRole('complementary', { name: 'Sessions' })).toHaveCount(1);

  // Exactly at the rail breakpoint the terminal is narrowest. Every phone key,
  // especially Pg↑ and End, must remain inside the bar and at least 44px wide.
  await page.setViewportSize({ width: 900, height: 800 });
  const keybarBox = await box(page.getByRole('navigation', { name: 'Terminal keys' }));
  for (const button of await page
    .getByRole('navigation', { name: 'Terminal keys' })
    .getByRole('button')
    .all()) {
    const buttonBox = await box(button);
    expect(buttonBox.width).toBeGreaterThanOrEqual(44);
    expect(buttonBox.x).toBeGreaterThanOrEqual(keybarBox.x);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(keybarBox.x + keybarBox.width + 1);
  }

  await page.setViewportSize({ width: 412, height: 915 });
  await expect(page.locator('main')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Back to sessions' })).toHaveCount(1);
});
