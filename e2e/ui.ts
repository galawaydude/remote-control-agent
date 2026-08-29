/** Browser geometry and evidence helpers shared by the terminal UI specs. */

import type { Locator, Page } from '@playwright/test';
import { join } from 'node:path';

/**
 * A phone with its on-screen keyboard up: the smallest viewport this product
 * supports, and the one two of its four clipped panels only failed at.
 *
 * A check at full phone height would have passed while the product was broken,
 * so it is a named constant rather than a literal in one spec.
 */
export const KEYBOARD_UP = { width: 360, height: 340 } as const;

/** Where a reviewer's copies go; set by the runner, ignored when it is not. */
const evidence = process.env['TETHER_E2E_SHOTS'];

/** A control is reachable when it is a 44px target wholly inside the viewport,
 * uncovered after its own container scrolls, while the document itself stays
 * fixed in both axes. */
export async function reachable(page: Page, control: Locator, name: string): Promise<void> {
  const view = page.viewportSize() ?? { width: 0, height: 0 };
  const at = `${name} at ${view.width}×${view.height}`;

  if ((await control.boundingBox()) === null) throw new Error(`${at}: not laid out at all`);
  await control.scrollIntoViewIfNeeded();

  const seen = await control.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    // Off the screen there is nothing to hit-test — `elementFromPoint` answers
    // `null` for every point outside the viewport, and reporting that as "nothing
    // is on top of it" would bury the fault that is actually there.
    const onScreen = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
    const top = onScreen ? document.elementFromPoint(x, y) : element;
    const named =
      top === null
        ? 'nothing at all'
        : top.tagName.toLowerCase() +
          (top.getAttribute('class') ?? '')
            .split(/\s+/)
            .filter(Boolean)
            .map((one) => `.${one}`)
            .join('');
    return {
      x: box.x,
      y: box.y,
      right: box.right,
      bottom: box.bottom,
      height: box.height,
      // `contains` rather than identity: a button's label is its own node and is
      // what a hit test lands on. Anything outside the control is on top of it.
      covered: top !== null && element.contains(top) ? null : named,
      taller: document.documentElement.scrollHeight - window.innerHeight,
      wider: document.documentElement.scrollWidth - window.innerWidth,
    };
  });

  const px = (value: number): string => `${Math.round(value)}px`;
  const faults: string[] = [];
  if (seen.height < 44)
    faults.push(`it is only ${px(seen.height)} tall, under the 44px tap target`);
  if (seen.y < -0.5) faults.push(`its top is ${px(-seen.y)} above the top of the screen`);
  if (seen.bottom > view.height + 0.5) {
    faults.push(`it ends ${px(seen.bottom - view.height)} below the bottom of the screen`);
  }
  if (seen.x < -0.5) faults.push(`its left edge is ${px(-seen.x)} off the screen`);
  if (seen.right > view.width + 0.5) {
    faults.push(`its right edge is ${px(seen.right - view.width)} off the screen`);
  }
  if (seen.covered !== null) faults.push(`${seen.covered} is lying on top of it`);
  if (seen.taller > 0.5) {
    faults.push(`the page itself is ${px(seen.taller)} taller than the screen`);
  }
  if (seen.wider > 0.5) {
    faults.push(`the page itself is ${px(seen.wider)} wider than the screen`);
  }

  if (faults.length > 0) throw new Error(`${at} is unreachable: ${faults.join('; ')}`);
}

/**
 * Evidence screenshots, namespaced by the spec that took them.
 *
 * Every spec writes into the one `TETHER_E2E_SHOTS` directory and `workers: 1`
 * runs them in sequence, so a shared counter meant the last spec to use a number
 * silently overwrote an earlier spec's image — and a reviewer opening it was
 * looking at another screen entirely. A prefix makes a new shot in one spec
 * unable to collide with another by construction.
 */
export function shots(spec: string): (page: Page, name: string) => Promise<void> {
  return async (page, name) => {
    if (evidence !== undefined) {
      await page.screenshot({ path: join(evidence, `${spec}-${name}.png`) });
    }
  };
}
