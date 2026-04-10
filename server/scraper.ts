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

// ── Scrape one client ─────────────────────────────────────────────────────────
async function scrapeClient(
  context: BrowserContext,
  accountId: string,
  clientName: string
): Promise<void> {
  const page = await context.newPage();
  try {
    const cleanName = clientName.replace(/^Account\s*/i, "").replace(/\s*\|.*$/, "").trim();
    console.log(`[Scraper] Loading account page for ${cleanName}`);

    await page.goto(`${BASE_URL}/lightning/r/Account/${accountId}/view`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(12000);

    // Detect SSO redirect
    const earlyText = await page.locator("body").innerText().catch(() => "");
    if (earlyText.includes("Use your password instead") || earlyText.includes("Sign in") || earlyText.length < 300) {
      console.log(`[Scraper] Session expired — SSO login page detected`);
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      throw new Error("SJP session expired. Please click 'Re-login to SJP' and complete SSO again.");
    }

    // Screenshot the account page
    await page.screenshot({ path: path.join(DATA_DIR, `debug-account-${accountId}.png`), fullPage: true });

    // ── Find and click the "Investment Accounts" section header or "View All" ─
    // Log all visible link/button text that might be clickable
    const clickableItems = await page.evaluate(() => {
      const items: { text: string; tag: string; href: string }[] = [];
      const els = document.querySelectorAll('a, button, [role="button"], h2, span.slds-card__header-title');
      for (const el of Array.from(els)) {
        const text = (el as HTMLElement).innerText?.trim().slice(0, 80);
        if (text && (
          text.toLowerCase().includes("investment") ||
          text.toLowerCase().includes("financial") ||
          text.toLowerCase().includes("view all") ||
          text.toLowerCase().includes("account") && text.length < 30
        )) {
          items.push({
            text,
            tag: el.tagName,
            href: (el as HTMLAnchorElement).href || "",
          });
        }
      }
      return items;
    });
    console.log(`[Scraper] Clickable items matching investment/financial:`, JSON.stringify(clickableItems));

    // Try clicking "Investment Accounts" header or nearby "View All" link
    let investmentComponentLoaded = false;

    // Strategy 1: Click the "Investment Accounts" title text which opens the component
    const investmentLink = await page.evaluate(() => {
      const allEls = document.querySelectorAll('a, button, span, h2');
      for (const el of Array.from(allEls)) {
        const text = (el as HTMLElement).innerText?.trim();
        if (text === "Investment Accounts" && (el.tagName === "A" || el.tagName === "BUTTON" || el.tagName === "SPAN")) {
          (el as HTMLElement).click();
          return text;
        }
      }
      return null;
    });

    if (investmentLink) {
      console.log(`[Scraper] Clicked: "${investmentLink}"`);
      await page.waitForTimeout(10000);
      investmentComponentLoaded = true;
    }

    // Strategy 2: If that didn't work, look for "View All" near investment section
    if (!investmentLink) {
      const viewAllClicked = await page.evaluate(() => {
        const viewAlls = document.querySelectorAll('a');
        for (const a of Array.from(viewAlls)) {
          const text = a.innerText?.trim().toLowerCase();
          if (text === "view all" || text.includes("view all")) {
            // Check if it's near an "Investment" label
            const section = a.closest('article, section, div[class*="card"]');
            if (section) {
              const sectionText = (section as HTMLElement).innerText;
              if (sectionText.includes("Investment") || sectionText.includes("Financial")) {
                a.click();
                return true;
              }
            }
          }
        }
        // Fallback: click first "View All"
        for (const a of Array.from(viewAlls)) {
          if (a.innerText?.trim().toLowerCase() === "view all") {
            a.click();
            return true;
          }
        }
        return false;
      });

      if (viewAllClicked) {
        console.log(`[Scraper] Clicked View All`);
        await page.waitForTimeout(10000);
        investmentComponentLoaded = true;
      }
    }

    // Screenshot after navigation attempt
    await page.screenshot({ path: path.join(DATA_DIR, `debug-invest-${accountId}.png`), fullPage: true });

    // Get page text
    const pageText = await page.locator("body").innerText().catch(() => "");
    console.log(`[Scraper] Page text length: ${pageText.length}`);

    // Log section around £ values or plan numbers
    const gbpIdx = pageText.indexOf("GBP");
    const planIdx = pageText.match(/UT\d{6}|IB\d{6}|IS\d{6}|PE\d{6}/);
    const startIdx = Math.max(0, Math.min(gbpIdx > 0 ? gbpIdx - 200 : 99999, planIdx?.index ?? 99999) - 50);
    if (startIdx < pageText.length) {
      console.log(`[Scraper] Data section:`, pageText.slice(startIdx, startIdx + 3000));
    } else {
      console.log(`[Scraper] First 2000 chars:`, pageText.slice(0, 2000));
    }

    // ── Click all expand arrows ─────────────────────────────────────────────────
    const expandCount = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll(
        'button[aria-expanded="false"], td button[title*="xpand"], td button[title*="Show"]'
      ));
      let clicked = 0;
      for (const btn of btns) {
        try { (btn as HTMLButtonElement).click(); clicked++; } catch {}
      }
      return clicked;
    });
    console.log(`[Scraper] Clicked ${expandCount} expand buttons`);
    if (expandCount > 0) await page.waitForTimeout(expandCount * 500 + 3000);

    // Get final page text after expanding
    const finalText = expandCount > 0
      ? await page.locator("body").innerText().catch(() => pageText)
      : pageText;

    // ── Extract total ─────────────────────────────────────────────────────────
    const totalMatch = finalText.match(/Total[:\s]*(?:GBP\s*)?£?([\d,]+\.\d{2})/i);
    const totalValue = totalMatch ? `£${totalMatch[1]}` : null;

    // Upsert client
    storage.upsertClient({
      id: accountId,
      name: cleanName,
      totalValue: totalValue ?? undefined,
      lastScraped: new Date().toISOString(),
    });
    storage.deleteAccountsByClient(accountId);

    // ── Extract from tables (including shadow DOM) ─────────────────────────────
    const tableData = await page.evaluate(() => {
      const allTables: { headers: string[]; rows: string[][] }[] = [];
      function findTables(root: Document | ShadowRoot | Element) {
        for (const table of Array.from(root.querySelectorAll("table"))) {
          const headers = Array.from(table.querySelectorAll("th"))
            .map(h => (h as HTMLElement).innerText.trim()).filter(Boolean);
          const rows = Array.from(table.querySelectorAll("tbody tr"))
            .map(row => Array.from(row.querySelectorAll("td")).map(c => (c as HTMLElement).innerText.trim()))
            .filter(row => row.some(c => c.length > 0));
          if (rows.length > 0) allTables.push({ headers, rows });
        }
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if ((el as any).shadowRoot) findTables((el as any).shadowRoot);
        }
      }
      findTables(document);
      return allTables;
    });

    console.log(`[Scraper] Found ${tableData.length} table(s)`);
    for (const t of tableData) {
      console.log(`[Scraper] Table: headers=${JSON.stringify(t.headers)}, rows=${t.rows.length}`);
      if (t.rows[0]) console.log(`[Scraper] First row: ${JSON.stringify(t.rows[0])}`);
    }

    let accountsFound = 0;
    let holdingsFound = 0;

    for (const { headers, rows } of tableData) {
      const hLower = headers.map(h => h.toLowerCase());
      const isPlanTable = hLower.some(h =>
        h.includes("plan") || h.includes("product") || h.includes("provider") || h.includes("current value")
      );
      if (!isPlanTable && tableData.length > 1) continue;

      let currentAccountId: string | null = null;
      const headerCount = headers.length;

      for (const cells of rows) {
        // Account row: first cell matches plan number pattern (UT/IB/IS/PE + digits)
        const firstCell = cells[0] ?? "";
        if (/^(UT|IB|IS|PE|PP)?\d{5,}/.test(firstCell) && cells.length >= Math.min(headerCount, 4)) {
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
          accountsFound++;
        }
        // Holding row: fund name + price data, under current account
        else if (currentAccountId && cells.length >= 2 && firstCell.length > 2 && !firstCell.match(/^(UT|IB|IS|PE|PP)?\d{5,}/)) {
          storage.insertHolding({
            accountId: currentAccountId,
            fundName: firstCell,
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

    // ── Text fallback if no tables ──────────────────────────────────────────────
    if (accountsFound === 0) {
      console.log(`[Scraper] No table parsed — trying text-based extraction`);
      const lines = finalText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      let currentAccountId: string | null = null;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Plan number patterns: UT004667970001, IB681178860001, 1031929, etc.
        if (/^(UT|IB|IS|PE|PP)\d{9,}$/.test(line) || /^\d{6,10}$/.test(line)) {
          const planNumber = line;
          const accountDbId = `${accountId}_${planNumber}`;
          currentAccountId = accountDbId;
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

    // Sum account values for client total
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
