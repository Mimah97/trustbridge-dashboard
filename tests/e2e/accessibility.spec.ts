/**
 * Accessibility tests for issue #560 — skip link and landmark audit.
 *
 * Tests:
 * 1. Skip link keyboard navigation on /dashboard/settings
 * 2. Axe-core scan of /dashboard/settings
 *
 * NOTE: These tests require a running dev server (`npm run dev`).
 * Run: npx playwright test tests/e2e/accessibility.spec.ts
 *
 * Auth: Both halves of sign-in are needed — `signInWithSessionCookie` mints
 * the JWT cookie that middleware decodes, and `mockMaintainerSession` feeds
 * the `/api/auth/session` payload `useSession()` reads.
 */

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext } from "@playwright/test";

import { filterBaselineViolations } from "./axe-baseline";
import {
  interceptApi,
  mockMaintainerSession,
  signInWithSessionCookie,
} from "./helpers";

// ── Shared fixtures ────────────────────────────────────────────────────────

const NETWORK_FIXTURE = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  horizonNetwork: "testnet",
  sorobanUrl: "https://soroban-testnet.stellar.org",
  sorobanNetwork: "testnet",
  sorobanContractConfigured: false,
  mismatched: false,
  warnings: [],
};

const AUDIT_FIXTURE = {
  entries: [],
  summary: { total: 0, byAction: {} },
};

const CONTRACT_SYNC_FIXTURE = {
  lastRun: {
    status: "ok",
    startedAt: new Date().toISOString(),
    durationMs: 12,
    synced: 3,
    created: 0,
    updated: 0,
    unchanged: 3,
  },
};

const DLQ_FIXTURE = {
  jobs: [],
  count: 0,
};

const FEATURE_FLAGS_FIXTURE = {
  flags: [
    {
      key: "MAINTAINER_TOOLS",
      enabled: true,
      source: "environment",
    },
  ],
};

/**
 * Sign in as maintainer and stub all endpoints /dashboard/settings fetches.
 * Mirrors the `setupSettingsPage` helper in settings-feature-flags.spec.ts.
 */
async function setupSettingsPage({
  page,
  context,
}: {
  page: Parameters<typeof interceptApi>[0];
  context: BrowserContext;
}) {
  await signInWithSessionCookie(context, {
    id: "maintainer-1",
    githubUsername: "octocat",
    isMaintainer: true,
  });
  await mockMaintainerSession(page);
  await interceptApi(page, "**/api/settings/network", NETWORK_FIXTURE);
  await interceptApi(page, "**/api/audit*", AUDIT_FIXTURE);
  await interceptApi(page, "**/api/auth/session-info", {
    session: {
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      expiresInSeconds: 86_400,
      maxAgeSeconds: 86_400,
      strategy: "jwt",
    },
  });
  await interceptApi(page, "**/api/settings/api-keys", { keys: [] });
  await interceptApi(page, "**/api/registrations/deleted", {
    registrations: [],
  });
  await interceptApi(
    page,
    "**/api/settings/feature-flags",
    FEATURE_FLAGS_FIXTURE
  );
  await interceptApi(page, "**/api/contract-sync", CONTRACT_SYNC_FIXTURE);
  await interceptApi(page, "**/api/contributors/queue/dlq", DLQ_FIXTURE);
}

// ── Skip link ──────────────────────────────────────────────────────────────

test.describe("Skip link", () => {
  test("skip link is visible on focus and targets #main-content", async ({
    page,
    context,
  }) => {
    await setupSettingsPage({ page, context });
    await page.goto("/dashboard/settings");

    // Wait for page to render
    await expect(page.getByTestId("feature-flags-panel")).toBeVisible();

    // Tab once — the skip link is the first focusable element in the body
    await page.keyboard.press("Tab");

    const skipLink = page.locator('a[href="#main-content"]');

    // The skip link transitions from sr-only to visible on focus
    await expect(skipLink).toBeVisible();
    await expect(skipLink).toBeFocused();

    // Verify href
    const href = await skipLink.getAttribute("href");
    expect(href).toBe("#main-content");

    // Click the skip link; main-content should receive focus
    await skipLink.click();

    // The <main id="main-content" tabIndex={-1}> element should be focused
    const focused = await page.evaluate(() => document.activeElement?.id ?? "");
    expect(focused).toBe("main-content");
  });
});

// ── Axe scan ──────────────────────────────────────────────────────────────

test.describe("Settings page accessibility", () => {
  test("the settings page has no axe violations beyond the baseline", async ({
    page,
    context,
  }) => {
    await setupSettingsPage({ page, context });
    await page.goto("/dashboard/settings");

    // Wait for all panels to settle before scanning
    await expect(page.getByTestId("feature-flags-panel")).toBeVisible();
    await expect(page.getByTestId("contract-sync-panel")).toBeVisible();
    await expect(page.getByTestId("dlq-panel")).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const violations = filterBaselineViolations(results.violations);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
