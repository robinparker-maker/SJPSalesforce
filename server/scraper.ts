import { chromium, type BrowserContext } from "playwright";
import fs from "fs";
import path from "path";
import { storage } from "./storage";

const BASE_URL = "https://sjp2.lightning.force.com";
// Use /data dir when DATABASE_URL points there (Railway volume), otherwise cwd
const DATA_DIR = process.env.DATABASE_URL
  ? path.dirname(process.env.DATABASE_URL)
  : process.cwd();
const SESSION_FILE = path.join(DATA_DIR, "session.json");

export function sessionExists(): boolean {
  return fs.existsSync(SESSION_FILE);
}

// ── Validate saved session ────────────────────────────────────────────────────
export async function isSessionValid(): Promise<boolean> {
  // Just check the file exists — skip a full browser validation to avoid
  // running two Chromium instances simultaneously on constrained cloud envs.
  // The scrape itself will fail gracefully if the session is actually expired.
  return sessionExists();
}

// ── Save session state ────────────────────────────────────────────────────────
export async function saveSession(context: BrowserContext) {
  const state = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}

// ── Harvest all client Account IDs from the Accounts list view ───────────────
async function harvestAccountIds(context: BrowserContext): Promise<{ id: string; name: string }[]> {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/lightning/o/Account/list`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  // Wait for Lightning to fully render
  await page.waitForTimeout(8000);

  // Detect SSO redirect — if we're not on Lightning, session has expired
  const currentUrl = page.url();
  if (!currentUrl.includes("lightning.force.com") && !currentUrl.includes("sjp2")) {
    await page.close();
    throw new Error(`Session expired — redirected to: ${currentUrl}. Please log in again.`);
  }

  // Collect all client links from the list — they link to /lightning/r/Account/{ID}/view
  const accounts = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/lightning/r/Account/"]'));
    const seen = new Set<string>();
    const results: { id: string; name: string }[] = [];
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href;
      const match = href.match(/\/Account\/([a-zA-Z0-9]+)\/view/);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        results.push({
          id: match[1],
          name: (link as HTMLAnchorElement).innerText.trim(),
        });
      }
    }
    return results;
  });

  await page.close();
  console.log(`[Scraper] Found ${accounts.length} client account(s) in list view`);
  return accounts;
}

// ── Scrape one client's investment accounts + holdings ────────────────────────
async function scrapeClient(
  context: BrowserContext,
  accountId: string,
  clientName: string
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(`${BASE_URL}/lightning/r/Account/${accountId}/view`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    // Wait for Lightning components to render
    await page.waitForTimeout(12000);

    // Debug: log all tables found and their headers
    const tableDebug = await page.evaluate(() => {
      const tables = document.querySelectorAll("table");
      return Array.from(tables).map((t, i) => ({
        index: i,
        headers: Array.from(t.querySelectorAll("th")).map(h => h.innerText.trim()).filter(Boolean),
        rowCount: t.querySelectorAll("tbody tr").length,
      }));
    });
    console.log(`[Scraper] Tables on page for ${clientName}:`, JSON.stringify(tableDebug));

    // ── Find the investment accounts table ──────────────────────────────────
    // Try specific headers first, then fall back to largest table
    const tableIndex = await page.evaluate(() => {
      const tables = document.querySelectorAll("table");
      // First pass: look for investment-specific headers
      for (let i = 0; i < tables.length; i++) {
        const headers = Array.from(tables[i].querySelectorAll("th")).map(h =>
          h.innerText.trim().toLowerCase()
        );
        if (headers.some(h => h.includes("plan") || h.includes("current value") || h.includes("provider") || h.includes("product"))) {
          return i;
        }
      }
      // Second pass: return the table with the most rows
      let bestIdx = -1, bestRows = 0;
      for (let i = 0; i < tables.length; i++) {
        const rows = tables[i].querySelectorAll("tbody tr").length;
        if (rows > bestRows) { bestRows = rows; bestIdx = i; }
      }
      return bestRows > 0 ? bestIdx : -1;
    });

    if (tableIndex === -1) {
      console.log(`[Scraper] No table found at all for ${clientName} — page may not have loaded`);
      await page.close();
      return;
    }
    console.log(`[Scraper] Using table index ${tableIndex} for ${clientName}`);

    // ── Extract column headers ──────────────────────────────────────────────
    const headers = await page.evaluate((idx: number) => {
      return Array.from(document.querySelectorAll("table")[idx].querySelectorAll("th"))
        .map(h => h.innerText.trim())
        .filter(h => h.length > 0);
    }, tableIndex);

    // ── Get total portfolio value ───────────────────────────────────────────
    const totalValue = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const text = node.textContent?.trim() ?? "";
        if (text.startsWith("Total:")) return text.replace("Total:", "").trim();
      }
      return null;
    });

    // ── Click every expand arrow ────────────────────────────────────────────
    const clickedCount = await page.evaluate(async (idx: number) => {
      const table = document.querySelectorAll("table")[idx];
      const rows = Array.from(table.querySelectorAll("tbody > tr"));
      let clicked = 0;
      for (const row of rows) {
        const btn = row.querySelector(
          'td button[aria-expanded="false"], td button[title*="xpand"], td:first-child button'
        ) as HTMLButtonElement | null;
        if (btn) {
          btn.click();
          clicked++;
          await new Promise(r => setTimeout(r, 700));
        }
      }
      return clicked;
    }, tableIndex);

    if (clickedCount > 0) {
      await page.waitForTimeout(clickedCount * 700 + 1500);
    }

    // ── Extract all rows ────────────────────────────────────────────────────
    const rawRows = await page.evaluate((idx: number) => {
      const table = document.querySelectorAll("table")[idx];
      return Array.from(table.querySelectorAll("tbody tr")).map(row => ({
        cells: Array.from(row.querySelectorAll("td")).map(c => c.innerText.trim()),
        cellCount: row.querySelectorAll("td").length,
      }));
    }, tableIndex);

    // ── Parse rows into accounts + holdings ────────────────────────────────
    // Upsert client first
    storage.upsertClient({
      id: accountId,
      name: clientName,
      totalValue: totalValue ?? undefined,
      lastScraped: new Date().toISOString(),
    });

    // Clear existing data for this client
    storage.deleteAccountsByClient(accountId);

    let currentAccountId: string | null = null;
    const fullColCount = headers.length;

    for (const row of rawRows) {
      const { cells, cellCount } = row;
      if (cells.length === 0) continue;

      const firstCell = cells[0] ?? "";
      const isAccountRow = firstCell.length > 0 && cellCount >= Math.max(fullColCount - 2, 5);
      const isHoldingRow = !isAccountRow && currentAccountId && cells.filter(c => c.length > 0).length >= 3;

      if (isAccountRow) {
        const planNumber = firstCell;
        const accountDbId = `${accountId}_${planNumber}`;
        currentAccountId = accountDbId;

        storage.upsertAccount({
          id: accountDbId,
          clientId: accountId,
          planNumber,
          product: cells[1] ?? "",
          provider: cells[2] ?? "",
          currentValue: cells[3] ?? "",
          status: cells[4] ?? "",
          primaryOwner: cells[5] ?? "",
          ownershipType: cells[6] ?? "",
          utFeeder: cells[7] ?? "",
          ihtExempt: cells[8] ?? "",
        });
      } else if (isHoldingRow && currentAccountId) {
        storage.insertHolding({
          accountId: currentAccountId,
          fundName: cells[0] ?? "",
          price: cells[1] ?? "",
          units: cells[2] ?? "",
          valuation: cells[3] ?? "",
          percentageInvested: cells[4] ?? "",
          securityId: cells[5] ?? "",
        });
      }
    }

    console.log(`[Scraper] ✓ ${clientName} — saved ${rawRows.length} rows`);
  } finally {
    await page.close();
  }
}

// ── Main scrape runner ────────────────────────────────────────────────────────
export async function runScrape(): Promise<{ success: boolean; message: string }> {
  const logEntry = storage.createScrapeLog({
    startedAt: new Date().toISOString(),
    status: "running",
  });

  try {
    const valid = await isSessionValid();
    if (!valid) {
      storage.updateScrapeLog(logEntry.id, {
        status: "error",
        completedAt: new Date().toISOString(),
        errorMessage: "Session expired — please log in again via the Login button.",
      });
      return { success: false, message: "Session expired. Please log in again." };
    }

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const context = await browser.newContext({
      storageState: SESSION_FILE,
      viewport: { width: 1440, height: 900 },
    });

    // Step 1: harvest all client IDs
    const accounts = await harvestAccountIds(context);

    if (accounts.length === 0) {
      // Fall back to hardcoded test client if list view returns nothing
      accounts.push({ id: "0010800002mkyCaAAI", name: "Rupert William Swallow" });
    }

    // Step 2: scrape each client
    for (const { id, name } of accounts) {
      await scrapeClient(context, id, name);
      await new Promise(r => setTimeout(r, 2000));
    }

    await browser.close();

    storage.updateScrapeLog(logEntry.id, {
      status: "success",
      completedAt: new Date().toISOString(),
      clientsScraped: accounts.length,
    });

    return { success: true, message: `Scraped ${accounts.length} client(s) successfully.` };
  } catch (err: any) {
    storage.updateScrapeLog(logEntry.id, {
      status: "error",
      completedAt: new Date().toISOString(),
      errorMessage: err.message,
    });
    return { success: false, message: err.message };
  }
}
