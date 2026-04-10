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

// ── Build the Investment Accounts component URL for a given Account ID ────────
function buildInvestmentUrl(accountId: string): string {
  const payload = {
    componentDef: "c:financialAccountList",
    attributes: {
      recordId: accountId,
      title: "Investment Accounts",
      iconName: "custom:custom16",
      recordTypeId: "01208000000gXQrAAM",
      recordtypesForFinancialAccounts: "Investment_SJP_Automated,Investments",
      fieldSetForFinancialAccount: "InvestmentAccountForComponent",
      fieldSetForFinancialHolding: "Fund_Assets_Holdings_Component",
      defaultRecordType: "Investments",
      fullView: true,
      iconSize: "medium",
      includeInActive: false,
      TotalFieldName: "CurrentValue_in_GBP__c",
    },
    state: {
      ws: `/lightning/r/Account/${accountId}/view`,
    },
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  return `${BASE_URL}/one/one.app#${b64}`;
}

// ── Harvest client Account IDs from list view ────────────────────────────────
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

// ── Scrape one client using the Investment Accounts component URL ──────────────
async function scrapeClient(
  context: BrowserContext,
  accountId: string,
  clientName: string
): Promise<void> {
  const page = await context.newPage();
  try {
    const cleanName = clientName.replace(/^Account\s*/i, "").replace(/\s*\|.*$/, "").trim();
    const url = buildInvestmentUrl(accountId);
    console.log(`[Scraper] Loading investment component for ${cleanName}`);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Wait for the component to render — it fetches data via Aura action
    await page.waitForTimeout(15000);

    // Click all expand/chevron buttons to reveal fund holdings
    const expandCount = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll(
        'button[aria-expanded="false"], td button, .slds-button_icon'
      ));
      let clicked = 0;
      for (const btn of btns) {
        try { (btn as HTMLButtonElement).click(); clicked++; } catch {}
      }
      return clicked;
    });
    console.log(`[Scraper] Clicked ${expandCount} expand buttons`);
    if (expandCount > 0) await page.waitForTimeout(expandCount * 300 + 3000);

    // Screenshot for debugging
    await page.screenshot({ path: path.join(DATA_DIR, `debug-invest-${accountId}.png`), fullPage: true });

    // Get the full rendered text
    const pageText = await page.locator("body").innerText().catch(() => "");
    console.log(`[Scraper] Page text length: ${pageText.length}`);
    console.log(`[Scraper] First 2000 chars:`, pageText.slice(0, 2000));

    // ── Find the total from the component ─────────────────────────────────────
    const totalMatch = pageText.match(/Total[:\s]*£?([\d,]+\.\d{2})/i) ||
                       pageText.match(/£([\d,]+\.\d{2})/);
    const totalValue = totalMatch ? `£${totalMatch[1]}` : null;

    // Upsert client
    storage.upsertClient({
      id: accountId,
      name: cleanName,
      totalValue: totalValue ?? undefined,
      lastScraped: new Date().toISOString(),
    });
    storage.deleteAccountsByClient(accountId);

    // ── Parse the investment accounts table ────────────────────────────────────
    // The c:financialAccountList component renders a table with:
    // Columns: Plan Number | Product | Provider | Current Value | Status | Primary Owner | Ownership Type | UT Feeder | IHT Exempt
    // Expanded rows: Fund Name | Price | Units | Valuation | % Invested | Security ID

    // Try structured table extraction first
    const tableData = await page.evaluate(() => {
      const allTables: { headers: string[]; rows: string[][] }[] = [];

      // Search both regular DOM and shadow DOM
      function findTables(root: Document | ShadowRoot | Element) {
        const tables = root.querySelectorAll("table");
        for (const table of Array.from(tables)) {
          const headers = Array.from(table.querySelectorAll("th"))
            .map(h => (h as HTMLElement).innerText.trim())
            .filter(Boolean);
          const rows = Array.from(table.querySelectorAll("tbody tr"))
            .map(row => Array.from(row.querySelectorAll("td")).map(c => (c as HTMLElement).innerText.trim()))
            .filter(row => row.some(c => c.length > 0));
          if (rows.length > 0) allTables.push({ headers, rows });
        }
        // Recurse into shadow roots
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if ((el as any).shadowRoot) findTables((el as any).shadowRoot);
        }
      }
      findTables(document);
      return allTables;
    });

    console.log(`[Scraper] Found ${tableData.length} table(s)`);
    for (const t of tableData) {
      console.log(`[Scraper] Table: ${t.headers.length} headers, ${t.rows.length} rows`);
      console.log(`[Scraper] Headers: ${JSON.stringify(t.headers)}`);
      if (t.rows[0]) console.log(`[Scraper] Row 0: ${JSON.stringify(t.rows[0])}`);
    }

    let accountsFound = 0;
    let holdingsFound = 0;

    // Parse investment accounts table
    for (const { headers, rows } of tableData) {
      const hLower = headers.map(h => h.toLowerCase());
      const hasPlan = hLower.some(h => h.includes("plan") || h.includes("product") || h.includes("provider") || h.includes("current value"));
      if (!hasPlan && tableData.length > 1) continue;

      let currentAccountId: string | null = null;
      const headerCount = headers.length;

      for (const cells of rows) {
        // Account row: has same number of cells as headers, first cell is plan number
        if (cells.length >= headerCount - 1 && /^\d{5,}/.test(cells[0])) {
          const planNumber = cells[0];
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
          accountsFound++;
        }
        // Holding row: fewer cells, nested under an account, first cell is fund name
        else if (currentAccountId && cells.length >= 2 && cells[0].length > 2 && !/^\d{5,}/.test(cells[0])) {
          storage.insertHolding({
            accountId: currentAccountId,
            fundName: cells[0] ?? "",
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

    // ── Fallback: text-based parsing if no table found ─────────────────────────
    if (accountsFound === 0) {
      console.log(`[Scraper] No table parsed — trying text-based extraction`);
      const lines = pageText.split("\n").map(l => l.trim()).filter(l => l.length > 0);

      let currentAccountId: string | null = null;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Plan number: 6+ digits
        if (/^\d{6,}$/.test(line)) {
          const planNumber = line;
          const accountDbId = `${accountId}_${planNumber}`;
          currentAccountId = accountDbId;

          // Gather next fields
          storage.upsertAccount({
            id: accountDbId,
            clientId: accountId,
            planNumber,
            product: lines[i + 1] ?? "",
            provider: lines[i + 2] ?? "",
            currentValue: lines[i + 3] ?? "",
            status: lines[i + 4] ?? "",
            primaryOwner: lines[i + 5] ?? "",
            ownershipType: lines[i + 6] ?? "",
            utFeeder: lines[i + 7] ?? "",
            ihtExempt: lines[i + 8] ?? "",
          });
          accountsFound++;
          i += 8;
        }
      }
    }

    // Update total from sum of accounts
    const allAccounts = storage.getAccountsByClient(accountId);
    const computedTotal = allAccounts.reduce((sum, a) => {
      const v = parseFloat((a.currentValue ?? "").replace(/[£,GBP\s]/g, ""));
      return isNaN(v) ? sum : sum + v;
    }, 0);
    if (computedTotal > 0) {
      storage.upsertClient({
        id: accountId,
        name: cleanName,
        totalValue: `£${computedTotal.toLocaleString("en-GB", { minimumFractionDigits: 2 })}`,
        lastScraped: new Date().toISOString(),
      });
    }

    console.log(`[Scraper] ✓ ${cleanName} — ${accountsFound} accounts, ${holdingsFound} holdings, total £${computedTotal.toLocaleString("en-GB")}`);
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
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
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
