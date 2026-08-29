import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { KEYBOARD_UP, reachable, shots } from './ui.ts';

const root = process.env['TETHER_E2E_DIR'] as string;
const project = join(root, 'terminal');
const resumeProject = join(root, 'terminal-resume');
const shoot = shots('session');
const GREETING = 'stub agent ready';

async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Password').fill(process.env['TETHER_E2E_PASSWORD'] as string);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function start(page: Page, cwd: string): Promise<void> {
  mkdirSync(cwd, { recursive: true });
  await page.getByRole('button', { name: 'New session' }).click();
  await page.getByLabel('Working directory').fill(cwd);
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.locator('.xterm-rows')).toContainText(GREETING);
}

async function typeAtTerminal(page: Page, text: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

test('a session opens as one terminal, reloads, and exposes its scrollback', async ({ page }) => {
  await signIn(page);
  await start(page, project);

  // Terminal is the session interface: no transcript pane and no view switch.
  await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
  await expect(page.locator('.conv')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conversation', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveCount(0);

  await typeAtTerminal(page, 'print terminal history');
  await expect(page.locator('.xterm-rows')).toContainText('HISTORY-120');

  const rows = page.locator('.xterm-rows');
  const latestScreen = await rows.innerText();
  const firstLatest = Number(/HISTORY-(\d+)/.exec(latestScreen)?.[1]);
  expect(firstLatest).toBeGreaterThan(0);
  const historyUp = page.getByRole('button', { name: 'Scroll terminal history up' });
  const latest = page.getByRole('button', { name: 'Jump to latest terminal output' });
  await expect(historyUp).toBeVisible();
  await expect(latest).toBeVisible();
  for (const control of [historyUp, latest]) {
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }

  await historyUp.click();
  await expect
    .poll(async () => Number(/HISTORY-(\d+)/.exec(await rows.innerText())?.[1]))
    .toBeLessThan(firstLatest);
  const firstPage = Number(/HISTORY-(\d+)/.exec(await rows.innerText())?.[1]);
  await historyUp.click();
  await expect
    .poll(async () => Number(/HISTORY-(\d+)/.exec(await rows.innerText())?.[1]))
    .toBeLessThan(firstPage);
  await latest.click();
  await expect.poll(() => rows.innerText()).toBe(latestScreen);
  await shoot(page, '1-terminal-with-history-controls');

  // The browser keeps no terminal log. Reload re-derives the pane from tmux.
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.locator('.xterm-rows')).toContainText('HISTORY-120');
  await expect(page.locator('.conv')).toHaveCount(0);
});

test('a transient restore failure keeps the selected terminal retryable', async ({ page }) => {
  await signIn(page);
  await start(page, join(root, 'terminal-retry'));
  const selected = page.url();
  let failed = false;
  await page.route('**/api/machines/local/sessions/*', async (route) => {
    if (!failed && route.request().method() === 'GET') {
      failed = true;
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    } else await route.continue();
  });

  await page.reload();
  await expect(page.getByRole('alert')).toContainText('server failed');
  expect(page.url()).toBe(selected);
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('region', { name: 'Terminal' })).toBeVisible();
});

test('a dead session resumes directly into its terminal', async ({ page }) => {
  await signIn(page);
  await start(page, resumeProject);

  await page.getByRole('button', { name: 'Back to sessions' }).click();
  const row = page.locator('.row').filter({ hasText: 'terminal-resume' });
  page.once('dialog', (dialog) => void dialog.accept());
  await row.getByRole('button', { name: 'Kill session' }).click();
  await expect(row.getByText('dead', { exact: true })).toHaveCount(1);

  await row.locator('.row-open').click();
  await expect(
    page.getByRole('region', { name: 'Terminal' }).getByText('Session ended'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Resume session' }).click();
  await expect(page.getByRole('status')).toHaveText('Live');
  await expect(page.locator('.xterm-rows')).toContainText(GREETING);

  await typeAtTerminal(page, 'continued in terminal');
  await expect(page.locator('.xterm-rows')).toContainText('echo continued in terminal');
});

for (const [width, height] of [
  [360, 640],
  [375, 667],
  [390, 500],
  [KEYBOARD_UP.width, KEYBOARD_UP.height],
] as const) {
  test(`the New session sheet stays reachable at ${width}x${height}`, async ({ page }) => {
    mkdirSync(project, { recursive: true });
    await page.setViewportSize({ width, height });
    await signIn(page);
    await page.getByRole('button', { name: 'New session' }).click();
    const agent = page.getByLabel('Agent');
    await agent.selectOption('codex');
    await page.getByLabel('Working directory').fill(project);
    await expect(page.locator('.sheet .note')).toHaveCount(2);

    await reachable(page, agent, 'the Agent picker');
    await agent.selectOption('claude-code');
    const accept = page.getByLabel('I trust this folder');
    await expect(accept).not.toBeChecked();
    await accept.check();
    await reachable(page, page.getByRole('button', { name: 'Start' }), 'Start');
  });
}
