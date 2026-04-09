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

  // Plan number: grab UT-prefixed number from text
  const planMatch = pageText.match(/UT\d{6,}/);
  const finalPlan = planNumber || (planMatch ? planMatch[0] : faId);

  // Current value: "Current Value\nGBP X" is the most reliable pattern
  const cvMatch = pageText.match(/Current Value\s*\nGBP\s*([\d,]+\.\d{2})/) ||
                  pageText.match(/GBP\s*([\d,]+\.\d{2})/);
  const finalValue = cvMatch ? `£${cvMatch[1]}` : currentValue;

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

    // ── Click "View All" on the Financial Accounts related list ────────────────
    // The main page only shows a preview — click View All to get all records
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(3000);

    // Try to find and click a "View All" link near the Financial Accounts section
    const viewAllClicked = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button'));
      for (const el of links) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase();
        const title = el.getAttribute('title')?.toLowerCase() ?? '';
        if ((text === 'view all' || title.includes('view all')) && 
            (el.closest('[data-component-id*="Financial"]') || el.closest('[class*="financial"]') || 
             el.closest('section') || el.closest('article'))) {
          (el as HTMLElement).click();
          return true;
        }
      }
      // Fallback: click any "View All" link
      for (const el of links) {
        const text = (el as HTMLElement).innerText?.trim().toLowerCase();
        if (text === 'view all') {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    console.log(`[Scraper] View All clicked: ${viewAllClicked}`);
    if (viewAllClicked) await page.waitForTimeout(5000);

    // ── Collect FinancialAccount IDs from current page ───────────────────────
    let faIds = await page.evaluate(() => {
      const seen = new Set<string>();
      const results: string[] = [];
      const links = Array.from(document.querySelectorAll('a[href*="FinancialAccount"]'));
      for (const link of links) {
        const href = (link as HTMLAnchorElement).href;
        if (href.includes("Securities")) continue;
        const m = href.match(/\/([a-zA-Z0-9]{15,18})\/view/);
        if (m && !seen.has(m[1])) { seen.add(m[1]); results.push(m[1]); }
      }
      return results;
    });
    console.log(`[Scraper] Found ${faIds.length} FinancialAccount IDs on page: ${JSON.stringify(faIds)}`);

    // Upsert client first — total value summed after visiting all FA records
    storage.upsertClient({
      id: accountId,
      name: cleanName,
      totalValue: undefined,
      lastScraped: new Date().toISOString(),
    });
    storage.deleteAccountsByClient(accountId);


    // ── If still only 1 FA ID, navigate directly to the related list URL ───────
    // Salesforce has a related list URL: /lightning/r/Account/{id}/related/FinServ__FinancialAccounts__r/view
    if (faIds.length <= 1) {
      console.log(`[Scraper] Only ${faIds.length} FA IDs found — trying related list URL`);
      const relatedUrl = `${BASE_URL}/lightning/r/Account/${accountId}/related/FinServ__FinancialAccounts__r/view`;
      await page.goto(relatedUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(8000);
      console.log(`[Scraper] Related list URL: ${page.url()}`);

      const relatedFaIds = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="FinancialAccount"]'));
        const seen = new Set<string>();
        const results: string[] = [];
        for (const link of links) {
          const href = (link as HTMLAnchorElement).href;
          if (href.includes("Securities")) continue;
          const m = href.match(/\/([a-zA-Z0-9]{15,18})\/view/);
          if (m && !seen.has(m[1])) { seen.add(m[1]); results.push(m[1]); }
        }
        return results;
      });
      console.log(`[Scraper] Found ${relatedFaIds.length} FA IDs from related list URL`);
      // Merge, keeping existing ones too
      const seen = new Set(faIds);
      for (const id of relatedFaIds) { if (!seen.has(id)) { seen.add(id); faIds.push(id); } }
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

    // Update client total value by summing all scraped account values
    const allAccounts = storage.getAccountsByClient(accountId);
    const total = allAccounts.reduce((sum, a) => {
      const v = parseFloat((a.currentValue ?? "").replace(/[£,\s]/g, ""));
      return isNaN(v) ? sum : sum + v;
    }, 0);
    if (total > 0) {
      storage.upsertClient({
        id: accountId,
        name: cleanName,
        totalValue: `£${total.toLocaleString("en-GB", { minimumFractionDigits: 2 })}`,
        lastScraped: new Date().toISOString(),
      });
    }

    console.log(`[Scraper] ✓ ${cleanName} — ${accountsFound} accounts, ${holdingsFound} holdings, total £${total.toLocaleString("en-GB")}`);
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
