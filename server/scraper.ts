import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "fs";
import path from "path";
import { storage } from "./storage";

const BASE_URL = "https://sjp2.lightning.force.com";
const DATA_DIR = process.env.DATABASE_URL
  ? path.dirname(process.env.DATABASE_URL)
  : process.cwd();
const SESSION_FILE = path.join(DATA_DIR, "session.json");

export function sessionExists(): boolean {
  return fs.existsSync(SESSION_FILE);
}

export async function isSessionValid(): Promise<boolean> {
  return sessionExists();
}

export async function saveSession(context: BrowserContext) {
  const state = await context.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}

// ── Harvest client Account IDs ────────────────────────────────────────────────
async function harvestAccountIds(context: BrowserContext): Promise<{ id: string; name: string }[]> {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/lightning/o/Account/list`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(8000);

  const currentUrl = page.url();
  if (!currentUrl.includes("lightning.force.com") && !currentUrl.includes("sjp2")) {
    await page.close();
    throw new Error(`Session expired — redirected to: ${currentUrl}. Please log in again.`);
  }

  const accounts = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/lightning/r/Account/"]'));
    const seen = new Set<string>();
    const results: { id: string; name: string }[] = [];
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href;
      const match = href.match(/\/Account\/([a-zA-Z0-9]+)\/view/);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        const rawName = (link as HTMLAnchorElement).innerText.trim();
        const cleanName = rawName.replace(/^Account\s*/i, "").replace(/\s*\|.*$/, "").trim();
        results.push({ id: match[1], name: cleanName || rawName });
      }
    }
    return results;
  });

  await page.close();
  console.log(`[Scraper] Found ${accounts.length} client account(s) in list view`);
  return accounts;
}

// ── Wait for a locator with retries ──────────────────────────────────────────
async function waitForAny(page: Page, selectors: string[], timeout = 20000): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 500 })) return sel;
      } catch {}
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

// ── Scrape one client ─────────────────────────────────────────────────────────
async function scrapeClient(
  context: BrowserContext,
  accountId: string,
  clientName: string
): Promise<void> {
  const page = await context.newPage();
  try {
    console.log(`[Scraper] Loading account page for ${clientName} (${accountId})`);
    await page.goto(`${BASE_URL}/lightning/r/Account/${accountId}/view`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Give Lightning time to bootstrap
    await page.waitForTimeout(10000);

    // Screenshot + log all tabs for debugging
    const screenshotPath = path.join(DATA_DIR, `debug-${accountId}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`[Scraper] Screenshot saved: ${screenshotPath}`);

    const allTabs = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[role="tab"], .slds-tabs__item a, .oneConsoleTabItem, a[data-tab-value]'));
      return els.map((el: any) => ({
        text: el.innerText?.trim().slice(0, 80),
        title: el.getAttribute("title"),
        label: el.getAttribute("data-label") || el.getAttribute("aria-label"),
      })).filter((t: any) => t.text || t.title);
    });
    console.log(`[Scraper] Tabs on page:`, JSON.stringify(allTabs));


    // ── Look for the Investment Accounts tab / related list ───────────────────
    // SJP uses a tabbed layout — find and click the Investment Accounts tab
    const investTabSelectors = [
      'a[title*="Investment Account"]',
      'a[data-label*="Investment"]',
      'li[title*="Investment Account"] a',
      'button[title*="Investment Account"]',
      '[role="tab"]:has-text("Investment Account")',
      'a:has-text("Investment Account")',
      '[role="tab"]:has-text("Investment")' ,
      'a:has-text("Investment")' ,
      '[role="tab"]:has-text("Financial")' ,
      'a:has-text("Financial Account")' ,
    ];

    const foundTab = await waitForAny(page, investTabSelectors, 15000);
    if (foundTab) {
      console.log(`[Scraper] Found Investment tab with selector: ${foundTab}`);
      await page.locator(foundTab).first().click();
      await page.waitForTimeout(5000);
    } else {
      console.log(`[Scraper] No Investment tab found — trying to scroll to related list`);
      // Scroll to bottom to trigger lazy-loaded related lists
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(5000);
    }

    // ── Wait for the Financial Account rows to appear ─────────────────────────
    // FinancialAccount rows have plan numbers — wait for any of these patterns
    const rowSelectors = [
      'a[href*="/lightning/r/FinancialAccount"]',
      'a[href*="FinServ__FinancialAccount"]',
      '[data-record-id][data-target-selection-name*="FinancialAccount"]',
      'lightning-formatted-text:has-text("£")',
      'td[data-label="Current Value"]',
      'td[data-label="Plan Number"]',
    ];

    const foundRow = await waitForAny(page, rowSelectors, 20000);
    console.log(`[Scraper] Financial Account rows found with: ${foundRow ?? "none"}`);

    // ── Extract all Financial Account links (these are the investment accounts) ─
    const financialAccounts = await page.evaluate(() => {
      // Get all links to FinancialAccount records
      const links = Array.from(document.querySelectorAll('a[href*="FinancialAccount"], a[href*="FinServ"]'));
      const seen = new Set<string>();
      const results: { id: string; href: string; text: string }[] = [];
      for (const link of links) {
        const href = (link as HTMLAnchorElement).href;
        const idMatch = href.match(/\/([a-zA-Z0-9]{15,18})(?:\/view)?$/);
        if (idMatch && !seen.has(idMatch[1])) {
          seen.add(idMatch[1]);
          results.push({
            id: idMatch[1],
            href,
            text: (link as HTMLAnchorElement).innerText.trim(),
          });
        }
      }
      return results;
    });
    console.log(`[Scraper] Found ${financialAccounts.length} FinancialAccount link(s)`);

    // ── Get page text via Playwright's accessibility tree (pierces shadow DOM) ─
    // Use page.locator('body').innerText() which Playwright resolves through shadow DOM
    const pageText = await page.locator("body").innerText().catch(() => "");
    console.log(`[Scraper] Page text length: ${pageText.length}`);

    // Log the section around plan numbers or £ values
    const gbpIdx = pageText.indexOf("£");
    const planIdx = pageText.toLowerCase().indexOf("plan");
    const startIdx = Math.max(0, Math.min(gbpIdx > 0 ? gbpIdx : 99999, planIdx > 0 ? planIdx : 99999) - 200);
    console.log(`[Scraper] Key section for ${clientName}:`, pageText.slice(startIdx, startIdx + 3000));

    // ── Get total value ───────────────────────────────────────────────────────
    const totalMatch = pageText.match(/Total[:\s]+£?([\d,]+\.?\d*)/i)
      ?? pageText.match(/£([\d,]+\.?\d*)\s*\n.*[Tt]otal/);
    const totalValue = totalMatch ? `£${totalMatch[1]}` : null;

    // ── Click all expand arrows ───────────────────────────────────────────────
    const expandBtns = page.locator('button[aria-expanded="false"], button[title*="xpand"], button[title*="Show row"]');
    const expandCount = await expandBtns.count();
    console.log(`[Scraper] Found ${expandCount} expand buttons`);
    for (let i = 0; i < expandCount; i++) {
      try { await expandBtns.nth(i).click({ timeout: 2000 }); await page.waitForTimeout(300); } catch {}
    }
    if (expandCount > 0) await page.waitForTimeout(expandCount * 500 + 2000);

    // Get updated text after expanding
    const expandedText = await page.locator("body").innerText().catch(() => pageText);

    // ── Parse from rows in the DOM ────────────────────────────────────────────
    // Try to get structured data from table cells using Playwright locators
    const tableData = await page.evaluate(() => {
      const results: { headers: string[]; rows: string[][] }[] = [];
      const tables = document.querySelectorAll("table");
      for (const table of tables) {
        const headers = Array.from(table.querySelectorAll("th")).map(h => h.innerText.trim()).filter(Boolean);
        const rows = Array.from(table.querySelectorAll("tbody tr")).map(row =>
          Array.from(row.querySelectorAll("td")).map(c => c.innerText.trim())
        ).filter(row => row.some(c => c.length > 0));
        if (rows.length > 0) results.push({ headers, rows });
      }
      return results;
    });
    console.log(`[Scraper] Table data found: ${tableData.length} tables, details:`, JSON.stringify(tableData.map(t => ({ headers: t.headers, rowCount: t.rows.length, firstRow: t.rows[0] }))));

    // ── Upsert client ─────────────────────────────────────────────────────────
    const cleanName = clientName.replace(/^Account\s*/i, "").replace(/\s*\|.*$/, "").trim();
    storage.upsertClient({
      id: accountId,
      name: cleanName,
      totalValue: totalValue ?? undefined,
      lastScraped: new Date().toISOString(),
    });
    storage.deleteAccountsByClient(accountId);

    // ── Try structured table parse first ─────────────────────────────────────
    let accountsFound = 0;
    let holdingsFound = 0;

    // Look for an investment table with plan/value headers
    for (const { headers, rows } of tableData) {
      const hLower = headers.map(h => h.toLowerCase());
      const isPlanTable = hLower.some(h => h.includes("plan") || h.includes("current value") || h.includes("product") || h.includes("provider"));
      if (!isPlanTable) continue;

      console.log(`[Scraper] Found investment table: headers=${JSON.stringify(headers)}, rows=${rows.length}`);
      let currentAccountId: string | null = null;

      for (const cells of rows) {
        if (cells.length === 0) continue;
        const first = cells[0] ?? "";

        // Account row: plan number is typically 6+ digits
        if (/^\d{5,}$/.test(first)) {
          const accountDbId = `${accountId}_${first}`;
          currentAccountId = accountDbId;
          storage.upsertAccount({
            id: accountDbId,
            clientId: accountId,
            planNumber: first,
            product: cells[1] ?? "",
            provider: cells[2] ?? "",
            currentValue: cells[3] ?? "",
            status: cells[4] ?? "",
            primaryOwner: cells[5] ?? "",
            ownershipType: cells[6] ?? "",
            utFeeder: cells[7] ?? "",
            ihtExempt: cells[8] ?? "",
          });
          accountsFound++;
        } else if (currentAccountId && cells.filter(c => c.length > 0).length >= 2) {
          // Holding row
          storage.insertHolding({
            accountId: currentAccountId,
            fundName: first,
            price: cells[1] ?? "",
            units: cells[2] ?? "",
            valuation: cells[3] ?? "",
            percentageInvested: cells[4] ?? "",
            securityId: cells[5] ?? "",
          });
          holdingsFound++;
        }
      }
    }

    // ── Fallback: parse from FinancialAccount links + page text ──────────────
    if (accountsFound === 0 && financialAccounts.length > 0) {
      console.log(`[Scraper] Falling back to FinancialAccount link parsing`);
      for (const fa of financialAccounts) {
        const accountDbId = `${accountId}_${fa.id}`;
        storage.upsertAccount({
          id: accountDbId,
          clientId: accountId,
          planNumber: fa.text || fa.id,
          product: "",
          provider: "",
          currentValue: "",
          status: "",
          primaryOwner: "",
          ownershipType: "",
          utFeeder: "",
          ihtExempt: "",
        });
        accountsFound++;
      }
    }

    console.log(`[Scraper] ✓ ${cleanName} — ${accountsFound} accounts, ${holdingsFound} holdings`);
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

    const accounts = await harvestAccountIds(context);
    if (accounts.length === 0) {
      accounts.push({ id: "0010800002mkyCaAAI", name: "Rupert William Swallow" });
    }

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
