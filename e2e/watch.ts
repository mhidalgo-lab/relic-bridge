// SPDX-License-Identifier: Apache-2.0
// Collects everything that must stay at zero in a healthy page: CSP / Trusted Types violations, console errors and
// warnings, uncaught script errors and failed same-origin requests.
import type { Page } from '@playwright/test';

export interface Watch {
  readonly problems: string[];
  /** Fails the test with every problem seen so far. */
  assertClean(): void;
  /** Forget the console error the browser logs for a deliberate HTTP error (a 403 or a 422 we provoked). */
  expectStatus(status: number): void;
}

export async function watch(page: Page): Promise<Watch> {
  const problems: string[] = [];
  await page.exposeFunction('__rbReport', (what: string) => {
    problems.push(what);
  });
  // addInitScript is injected by the browser engine itself, so the page's own CSP does not block it.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __rbReport(s: string): void }).__rbReport(
        `CSP violation: ${e.violatedDirective} blocked ${e.blockedURI} (${e.sample})`,
      );
    });
  });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
  return {
    problems,
    expectStatus(status) {
      for (let i = problems.length - 1; i >= 0; i--) {
        if (problems[i]?.includes(`status of ${status} `)) problems.splice(i, 1);
      }
    },
    assertClean() {
      if (problems.length > 0) throw new Error(`browser problems:\n${problems.join('\n')}`);
    },
  };
}
