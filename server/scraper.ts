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

// ── Harvest client Account IDs from the list view ────────────────────────────
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
      const match = href.match(/\/Account\/([a-zA-Z0-9]{15,18})\/view/);
      if (match && !seen.has(match[1])) {
        seen.add(match[1]);
        const rawName = (link as HTMLAnchorElement).innerText.trim();
        results.push({ id: match[1], name: rawName || match[1] });
      }
    }
    return results;
  });

  await page.close();
  console.log(`[Scraper] Found ${accounts.length} client account(s) in list view`);
  return accounts;
}

// ── Extract a field value from page text ─────────────────────────────────────
function extractField(text: string, ...labels: string[]): string {
  for (const label of labels) {
    // Look for label followed by value on next non-empty token
    const idx = text.indexOf(label);
    if (idx === -1) continue;
    const after = text.slice(idx + label.length);
    // Get first non-empty line after label
    const lines = after.split("\n").map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith("Help ") && !l.startsWith("Edit ") && !l.startsWith("Open "));
    if (lines[0]) return lines[0];
  }
  return "";
}

// ── Scrape one Financial Account record page ──────────────────────────────────
async function scrapeFinancialAccount(
  page: Page,
  faId: string,
  clientId: string
): Promise<{ accountDbId: string; planNumber: string } | null> {
  console.log(`[Scraper] Loading FinancialAccount ${faId}`);
  await page.goto(`${BASE_URL}/lightning/r/FinServ__FinancialAccount__c/${faId}/view`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.waitForTimeout(8000);

  const pageText = await page.locator("body").innerText().catch(() => "");
  console.log(`[Scraper] FA ${faId} text length: ${pageText.length}`);

  // Extract fields using label matching
  const planNumber     = extractField(pageText, "Plan Number\n", "UT00");
  const currentValue   = extractField(pageText, "Current Value\n", "GBP ");
  const provider       = extractField(pageText, "Provider\n");
  const product        = extractField(pageText, "Product\n");
  const status         = extractField(pageText, "Status\n");
  const primaryOwner   = extractField(pageText, "Primary Owner\n");
  const ownershipType  = extractField(pageText, "Trust Classification\n", "Individual Contracts\n");
  const utFeeder       = extractField(pageText, "UT Feeder?\n");
  const ihtExempt      = extractField(pageText, "IHT Exempt\n");

  // Plan number fallback: grab UT-prefixed number from text
  const planMatch = pageText.match(/UT\d{9,}/);
  const finalPlan = planNumber || (planMatch ? planMatch[0] : faId);

  // Current value: look for GBP pattern
  const gbpMatch = pageText.match(/GBP\s+([\d,]+\.?\d*)/);
  const finalValue = currentValue || (gbpMatch ? `£${gbpMatch[1]}` : "");

  const accountDbId = `${clientId}_${finalPlan}`;

  storage.upsertAccount({
    id: accountDbId,
    clientId,
    planNumber: finalPlan,
    product,
    provider,
    currentValue: finalValue,
    status,
    primaryOwner,
    ownershipType,
    utFeeder,
    ihtExempt,
  });

  console.log(`[Scraper] FA saved: ${finalPlan} = ${finalValue}, ${status}, ${provider}`);
  return { accountDbId, planNumber: finalPlan };
}

// ── Scrape fund holdings for a Financial Account ──────────────────────────────
async function scrapeFundHoldings(
  page: Page,
  faId: string,
  accountDbId: string
): Promise<number> {
  // Holdings are in a related list on the FinancialAccount page
  // They're FinServ__Securities__c records — look for them in related list
  const pageText = await page.locator("body").innerText().catch(() => "");

  // Find securities section
  const secIdx = pageText.toLowerCase().indexOf("securities");
  if (secIdx === -1) {
    console.log(`[Scraper] No securities section found for ${faId}`);
    return 0;
  }

  const secText = pageText.slice(secIdx, secIdx + 5000);
  console.log(`[Scraper] Securities section for ${faId}:`, secText.slice(0, 500));

  // Try to get holdings from table
  const tableData = await page.evaluate(() => {
    const results: string[][] = [];
    for (const table of Array.from(document.querySelectorAll("table"))) {
      const headers = Array.from(table.querySelectorAll("th")).map(h => h.innerText.trim());
      const hasFund = headers.some(h => h.toLowerCase().includes("fund") || h.toLowerCase().includes("secur") || h.toLowerCase().includes("name"));
      if (!hasFund) continue;
      for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
        const cells = Array.from(row.querySelectorAll("td")).map(c => c.innerText.trim());
        if (cells.some(c => c.length > 0)) results.push(cells);
      }
    }
    return results;
  });

  let count = 0;
  for (const cells of tableData) {
    if (cells.length < 2) continue;
    storage.insertHolding({
      accountId: accountDbId,
      fundName: cells[0] ?? "",
      price: cells[1] ?? "",
      units: cells[2] ?? "",
      valuation: cells[3] ?? "",
      percentageInvested: cells[4] ?? "",
      securityId: cells[5] ?? "",
    });
    count++;
  }
  return count;
}

// ── Scrape one client — get all their Financial Accounts then visit each ──────
async function scrapeClient(
  context: BrowserContext,
  accountId: string,
  clientName: string
): Promise<void> {
  const page = await context.newPage();
  try {
    const cleanName = clientName.replace(/^Account\s*/i, "").replace(/\s*\|.*$/, "").trim();
    console.log(`[Scraper] Loading account page for ${cleanName} (${accountId})`);

    await page.goto(`${BASE_URL}/lightning/r/Account/${accountId}/view`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(10000);

    // ── Collect all FinancialAccount IDs from the related list ────────────────
    // They appear as tabs in the console — each has a Salesforce record ID
    // Also check for links in the page body
    const faIds = await page.evaluate(() => {
      const seen = new Set<string>();
      const results: string[] = [];

      // Method 1: links in page
      const links = Array.from(document.querySelectorAll('a[href*="FinancialAccount"], a[href*="FinServ"]'));
      for (const link of links) {
        const href = (link as HTMLAnchorElement).href;
        const m = href.match(/\/([a-zA-Z0-9]{15,18})(?:\/view)?/);
        if (m && !seen.has(m[1]) && m[1] !== window.location.pathname.split("/")[4]) {
          seen.add(m[1]);
          results.push(m[1]);
        }
      }

      // Method 2: tab titles that look like plan numbers (UT...)
      const tabs = Array.from(document.querySelectorAll('[title*="Financial Account"]'));
      for (const tab of tabs) {
        const href = (tab as HTMLAnchorElement).href || tab.closest('a')?.href || "";
        const m = href.match(/\/([a-zA-Z0-9]{15,18})(?:\/view)?/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          results.push(m[1]);
        }
      }

      return results;
    });

    console.log(`[Scraper] Found ${faIds.length} FinancialAccount IDs on page: ${JSON.stringify(faIds)}`);

    // ── Get total portfolio value from page text ───────────────────────────────
    const mainPageText = await page.locator("body").innerText().catch(() => "");
    const totalMatch = mainPageText.match(/£([\d,]+\.\d{2})/g);
    // The largest £ value is likely the total
    let totalValue: string | null = null;
    if (totalMatch) {
      const values = totalMatch.map(v => parseFloat(v.replace(/[£,]/g, "")));
      const max = Math.max(...values);
      totalValue = `£${max.toLocaleString("en-GB", { minimumFractionDigits: 2 })}`;
    }

    // Upsert client
    storage.upsertClient({
      id: accountId,
      name: cleanName,
      totalValue: totalValue ?? undefined,
      lastScraped: new Date().toISOString(),
    });
    storage.deleteAccountsByClient(accountId);

    // ── If no FA IDs found via links, try querying the SOQL-like API path ────
    // Fall back: open the FinancialAccount list filtered by parent account
    if (faIds.length === 0) {
      console.log(`[Scraper] No FA links found on main page — trying FinancialAccount list`);
      await page.goto(
        `${BASE_URL}/lightning/o/FinServ__FinancialAccount__c/list`,
        { waitUntil: "domcontentloaded", timeout: 60000 }
      );
      await page.waitForTimeout(8000);

      const listFaIds = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="FinancialAccount"]'));
        const seen = new Set<string>();
        const results: string[] = [];
        for (const link of links) {
          const href = (link as HTMLAnchorElement).href;
          const m = href.match(/FinancialAccount[^/]*\/([a-zA-Z0-9]{15,18})\/view/);
          if (m && !seen.has(m[1])) {
            seen.add(m[1]);
            results.push(m[1]);
          }
        }
        return results;
      });
      console.log(`[Scraper] Found ${listFaIds.length} FA IDs from list view`);
      faIds.push(...listFaIds);
    }

    // ── Visit each Financial Account and extract data ─────────────────────────
    let accountsFound = 0;
    let holdingsFound = 0;

    for (const faId of faIds) {
      const result = await scrapeFinancialAccount(page, faId, accountId);
      if (result) {
        accountsFound++;
        const h = await scrapeFundHoldings(page, faId, result.accountDbId);
        holdingsFound += h;
      }
      await page.waitForTimeout(1000);
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
