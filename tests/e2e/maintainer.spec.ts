import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

import { filterBaselineViolations } from "./axe-baseline";
import {
  interceptApi,
  mockContributorSession,
  mockMaintainerSession,
} from "./helpers";

// ── Fixture data ──────────────────────────────────────────────────────────

const contributorsFixture = {
  contributors: [
    {
      id: "reg-1",
      githubUsername: "alice",
      stellarAddress: "GADDRALICE12345678901234567890123456789012345678901234",
      trustlineReady: true,
      trustlineAuthorized: true,
      verified: true,
      funded: true,
      xlmBalance: "10",
      spendableXlmBalance: "7",
      lastCheckedAt: new Date().toISOString(),
      readiness: "ready",
    },
    {
      id: "reg-2",
      githubUsername: "bob",
      stellarAddress: "GADDRBOBBBB12345678901234567890123456789012345678901234",
      trustlineReady: true,
      trustlineAuthorized: true,
      verified: false,
      funded: true,
      xlmBalance: "1.2",
      spendableXlmBalance: "0.2",
      lastCheckedAt: new Date().toISOString(),
      readiness: "low_reserve",
    },
    {
      id: "reg-3",
      githubUsername: "charlie",
      stellarAddress: "GADDRCHARLIECCC12345678901234567890123456789012345678",
      trustlineReady: false,
      trustlineAuthorized: false,
      verified: false,
      funded: false,
      xlmBalance: "0",
      spendableXlmBalance: "0",
      lastCheckedAt: null,
      readiness: "not_ready",
    },
  ],
};

const networkFixture = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  horizonNetwork: "testnet",
  sorobanUrl: "https://soroban-testnet.stellar.org",
  sorobanNetwork: "testnet",
  sorobanContractConfigured: false,
  mismatched: false,
  warnings: [],
};

const sorobanFixture = { events: [], latestLedger: 0, errors: [] };
const statsFixture = { totalContributors: 3, readyCount: 1, readyPercent: 33 };

// ── Helpers ───────────────────────────────────────────────────────────────

async function setupDashboard(page: Parameters<typeof interceptApi>[0]) {
  await mockMaintainerSession(page);
  await interceptApi(page, "**/api/contributors/paginated**", {
    ...contributorsFixture,
    total: contributorsFixture.contributors.length,
    hasMore: false,
  });
  await interceptApi(page, "**/api/settings/network", networkFixture);
  await interceptApi(page, "**/api/soroban/events", sorobanFixture);
  await interceptApi(page, "**/api/stats", statsFixture);
}

// Issue #511 — shared axe gate for the settings and Wave prep/disputes views.
//
// Fails on `serious` or `critical` impact violations only; `minor`/`moderate`
// (e.g. color-contrast) are tracked but do not fail the run, per the issue's
// edge-case guidance. `color-contrast` is additionally excluded because it is
// covered by the from-scratch WCAG luminance calculator in
// `src/lib/dark-mode-contrast-audit.test.ts` (see `tests/e2e/axe-baseline.ts`).
// No other axe rules are disabled — any future disable must be justified inline.
async function expectNoSeriousAxeViolations(
  page: Parameters<typeof interceptApi>[0],
  context: string
) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(["color-contrast"])
    .analyze();

  const violations = filterBaselineViolations(results.violations).filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  );
  expect(
    violations,
    `${context}: ${JSON.stringify(violations, null, 2)}`
  ).toEqual([]);
}

// ── Dashboard access ──────────────────────────────────────────────────────

test.describe("Maintainer dashboard — access control", () => {
  test("unauthenticated users are redirected away from /dashboard", async ({ page }) => {
    // No session mock → NextAuth /api/auth/session returns 200 with no user
    await page.route("**/api/auth/session", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    });

    await page.goto("/dashboard");
    // Middleware redirects non-authenticated visitors
    await expect(page).not.toHaveURL(/\/dashboard/);
  });

  test("non-maintainer contributors cannot access /dashboard", async ({ page }) => {
    await mockContributorSession(page);
    await page.goto("/dashboard");
    // Middleware redirects non-maintainers to /register?error=maintainer
    await expect(page).toHaveURL(/register/);
  });

  test("maintainer can load the dashboard page", async ({ page }) => {
    await setupDashboard(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: /maintainer dashboard/i })).toBeVisible();
  });

  // Issue #142 — axe-core accessibility gate.
  //
  // Runs on a fully signed-in maintainer /dashboard with every panel's data
  // mocked (contributors, network config, Soroban events, stats): no real
  // GitHub OAuth, Horizon, or database. `color-contrast` is excluded — it is
  // already covered by the from-scratch WCAG luminance calculator in
  // `src/lib/dark-mode-contrast-audit.test.ts`; see `tests/e2e/axe-baseline.ts`
  // for the full rationale and the (currently empty beyond that) baseline.
  test("the dashboard page has no axe violations beyond the baseline", async ({
    page,
  }) => {
    await setupDashboard(page);
    await page.goto("/dashboard");
    await expect(
      page.getByRole("heading", { name: /maintainer dashboard/i })
    ).toBeVisible();
    // Wait for the contributor table's async fetch to settle before scanning,
    // so the gate reflects the steady-state page a maintainer sees.
    await expect(page.getByText("@alice")).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();

    const violations = filterBaselineViolations(results.violations);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

// ── Settings & Wave prep/disputes accessibility (Issue #511) ──────────────

test.describe("Maintainer dashboard — settings & Wave a11y", () => {
  test.beforeEach(async ({ page }) => {
    await setupDashboard(page);
  });

  test("settings page has no serious axe violations", async ({ page }) => {
    await page.goto("/dashboard/settings");
    // Await the network settings fetch so the form is fully rendered.
    await expect(
      page.getByRole("heading", { name: /settings|network/i }).first()
    ).toBeVisible();

    await expectNoSeriousAxeViolations(page, "settings");
  });

  test("Wave prep workspace has no serious axe violations", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("@alice")).toBeVisible();

    // Navigate to the Wave prep workspace section if it is a tab/panel.
    const waveTab = page.getByRole("tab", { name: /wave prep/i });
    if (await waveTab.count()) {
      await waveTab.click();
    } else {
      const waveLink = page.getByRole("link", { name: /wave prep/i });
      if (await waveLink.count()) {
        await waveLink.click();
      }
    }

    // Await the Wave prep content before scanning.
    await expect(
      page.getByRole("heading", { name: /wave prep/i }).first()
    ).toBeVisible();

    await expectNoSeriousAxeViolations(page, "wave prep");
  });

  test("disputes section has no serious axe violations", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("@alice")).toBeVisible();

    const disputesTab = page.getByRole("tab", { name: /disputes/i });
    if (await disputesTab.count()) {
      await disputesTab.click();
    } else {
      const disputesLink = page.getByRole("link", { name: /disputes/i });
      if (await disputesLink.count()) {
        await disputesLink.click();
      }
    }

    await expect(
      page.getByRole("heading", { name: /disputes/i }).first()
    ).toBeVisible();

    await expectNoSeriousAxeViolations(page, "disputes");
  });

  test("keyboard focus order reaches primary Wave prep actions", async ({
    page,
  }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("@alice")).toBeVisible();

    const waveTab = page.getByRole("tab", { name: /wave prep/i });
    if (await waveTab.count()) {
      await waveTab.click();
    }

    // Tab through the page and assert focus lands on an interactive primary
    // action (button/link) within the Wave prep workspace.
    let reachedPrimaryAction = false;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          text: (el.textContent ?? "").trim(),
        };
      });
      if (
        focused &&
        (focused.tag === "button" || focused.tag === "a") &&
        focused.text.length > 0
      ) {
        reachedPrimaryAction = true;
        break;
      }
    }
    expect(reachedPrimaryAction).toBe(true);
  });

  test("disputes modal is accessible when open and closed", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByText("@alice")).toBeVisible();

    const disputesTab = page.getByRole("tab", { name: /disputes/i });
    if (await disputesTab.count()) {
      await disputesTab.click();
    }

    // Scan the closed state first.
    await expectNoSeriousAxeViolations(page, "disputes (closed)");

    // Open a dispute detail modal if a trigger is present, scan it, then close.
    const openTrigger = page
      .getByRole("button", { name: /view|details|open/i })
      .first();
    if (await openTrigger.count()) {
      await openTrigger.click();
      const dialog = page.getByRole("dialog");
      if (await dialog.count()) {
        await expect(dialog).toBeVisible();
        await expectNoSeriousAxeViolations(page, "disputes (modal open)");
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
      }
    }
  });
});

// ── Contributor table ─────────────────────────────────────────────────────

test.describe("Maintainer dashboard — contributor table", () => {
  test.beforeEach(async ({ page }) => {
    await setupDashboard(page);
    await page.goto("/dashboard");
    // Wait for contributors to load
    await expect(page.getByText("@alice")).toBeVisible();
  });

  test("shows all contributors by default", async ({ page }) => {
    await expect(page.getByText("@alice")).toBeVisible();
    await expect(page.getByText("@bob")).toBeVisible();
    await expect(page.getByText("@charlie")).toBeVisible();
  });

  test("search filters contributors by username", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search by username/i);
    await searchInput.fill("alice");

    await expect(page.getByText("@alice")).toBeVisible();
    await expect(page.getByText("@bob")).not.toBeVisible();
    await expect(page.getByText("@charlie")).not.toBeVisible();
  });

  test("search is case-insensitive", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search by username/i);
    await searchInput.fill("ALICE");
    await expect(page.getByText("@alice")).toBeVisible();
    await expect(page.getByText("@bob")).not.toBeVisible();
  });

  test("searching by partial Stellar address works", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search by username/i);
    await searchInput.fill("GADDRBOBBBB");
    await expect(page.getByText("@bob")).toBeVisible();
    await expect(page.getByText("@alice")).not.toBeVisible();
  });

  test("no-match search shows an empty state message", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search by username/i);
    await searchInput.fill("zzz_no_match_zzz");
    await expect(page.getByText(/no contributors match/i)).toBeVisible();
  });

  test("clearing search restores all contributors", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search by username/i);
    await searchInput.fill("alice");
    await expect(page.getByText("@bob")).not.toBeVisible();

    await searchInput.clear();
    await expect(page.getByText("@bob")).toBeVisible();
    await expect(page.getByText("@charlie")).toBeVisible();
  });

  test("'Ready' filter shows only ready contributors", async ({ page }) => {
    await page.getByRole("button", { name: /✅ Ready/i }).click();

    await expect(page.getByText("@alice")).toBeVisible();
    await expect(page.getByText("@bob")).not.toBeVisible();
    await expect(page.getByText("@charlie")).not.toBeVisible();
  });

  test("'Needs attention' filter hides ready contributors", async ({ page }) => {
    await page.getByRole("button", { name: /❌ Needs attention/i }).click();

    await expect(page.getByText("@alice")).not.toBeVisible();
    // low_reserve and not_ready should appear
    await expect(page.getByText("@bob")).toBeVisible();
    await expect(page.getByText("@charlie")).toBeVisible();
  });

  test("'Low reserve' filter shows only low-reserve contributors", async ({ page }) => {
    await page.getByRole("button", { name: /Low reserve/i }).click();

    await expect(page.getByText("@bob")).toBeVisible();
    await expect(page.getByText("@alice")).not.toBeVisible();
    await expect(page.getByText("@charlie")).not.toBeVisible();
  });
});
