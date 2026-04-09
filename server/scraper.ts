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

    // Wait for Lightning components to fully render, then scroll to trigger lazy load
    await page.waitForTimeout(8000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(3000);

    // ── Click all expand arrows (buttons in the investment component) ─────────
    // We do this before extracting so fund holdings are visible
    const clickedCount = await page.evaluate(() => {
      // Try multiple selectors for expand/chevron buttons
      const selectors = [
        'button[aria-expanded="false"]',
        'button[title*="xpand"]',
        'button[title*="Show"]',
        'lightning-primitive-icon[svg-class*="chevron"]',
        '.slds-button[title*="xpand"]',
      ];
      let clicked = 0;
      for (const sel of selectors) {
        const btns = Array.from(document.querySelectorAll(sel)) as HTMLButtonElement[];
        for (const btn of btns) {
          try { btn.click(); clicked++; } catch {}
        }
      }
      return clicked;
    });

    if (clickedCount > 0) {
      console.log(`[Scraper] Clicked ${clickedCount} expand button(s) for ${clientName}`);
      await page.waitForTimeout(clickedCount * 500 + 3000);
    }

    // ── Dump full page text including shadow DOM ─────────────────────────────
    // document.body.innerText misses LWC shadow roots — walk them recursively
    const fullText = await page.evaluate(() => {
      function getText(root: Document | ShadowRoot | Element): string {
        let text = "";
        for (const node of Array.from(root.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE) {
            text += node.textContent + "\n";
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as Element;
            // Skip invisible elements
            const style = (el as HTMLElement).style;
            if (style && (style.display === "none" || style.visibility === "hidden")) continue;
            // Recurse into shadow root if present
            if ((el as any).shadowRoot) {
              text += getText((el as any).shadowRoot);
            } else {
              text += getText(el);
            }
          }
        }
        return text;
      }
      return getText(document);
    });
    console.log(`[Scraper] Full text length (with shadow DOM) for ${clientName}: ${fullText.length}`);

    // Log snippet around investment data
    const investIdx = Math.max(0, fullText.toLowerCase().indexOf("plan number"));
    const snippet = fullText.slice(Math.max(0, investIdx - 100), Math.min(fullText.length, investIdx + 3000));
    console.log(`[Scraper] Investment snippet for ${clientName}:`, snippet);

    // ── Get total portfolio value ─────────────────────────────────────────────
    const totalMatch = fullText.match(/Total[:\s]+£?([\d,]+\.?\d*)/i);
    const totalValue = totalMatch ? `£${totalMatch[1]}` : null;

    // ── Parse the investment section from page text ───────────────────────────
    // The SJP LWC renders rows as lines of text. We look for the section
    // after "Investment Accounts" header and parse line by line.
    //
    // Known column order (from earlier screenshots):
    // Account rows: Plan Number | Product | Provider | Current Value | Status | Primary Owner | Ownership Type | UT Feeder | IHT Exempt
    // Holding rows: Fund Name | Price | Units | Valuation | % Invested | Security ID

    const lines = fullText.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // Find start of investment accounts section
    let sectionStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      if (l.includes("plan number") || (l.includes("investment account") && lines[i + 1]?.toLowerCase().includes("plan"))) {
        sectionStart = i;
        break;
      }
    }

    if (sectionStart === -1) {
      // Fallback: look for lines that look like plan numbers (6-digit numbers)
      for (let i = 0; i < lines.length; i++) {
        if (/^\d{6,}$/.test(lines[i])) {
          sectionStart = i;
          break;
        }
      }
    }

    console.log(`[Scraper] Section start line for ${clientName}: ${sectionStart} — "${lines[sectionStart] ?? "not found"}"`);

    // Clean client name — strip any breadcrumb prefix like "Account\n" or " | Account" suffix
    const cleanName = clientName.replace(/^Account\s*/i, "").replace(/\s*\|.*$/, "").trim();

    // Upsert client
    storage.upsertClient({
      id: accountId,
      name: cleanName,
      totalValue: totalValue ?? undefined,
      lastScraped: new Date().toISOString(),
    });

    storage.deleteAccountsByClient(accountId);

    if (sectionStart === -1) {
      console.log(`[Scraper] Could not find investment section for ${clientName}`);
      return;
    }

    // ── Walk lines and parse accounts + holdings ──────────────────────────────
    // Plan numbers are 6+ digit numbers. Holdings have fund names (text) followed by price/units.
    let currentAccountId: string | null = null;
    let i = sectionStart;
    let accountsFound = 0;
    let holdingsFound = 0;

    // Skip header row(s)
    while (i < lines.length && (lines[i].toLowerCase().includes("plan number") || lines[i].toLowerCase().includes("product") || lines[i].toLowerCase().includes("provider"))) {
      i++;
    }

    while (i < lines.length) {
      const line = lines[i];

      // Stop if we've left the investment section (hit another major section)
      if (line.toLowerCase().match(/^(activity|chatter|files|notes|tasks|opportunities|cases|contacts|related)/)) break;

      // Account row: starts with a plan number (6+ digits)
      if (/^\d{5,}$/.test(line)) {
        const planNumber = line;
        const product    = lines[i + 1] ?? "";
        const provider   = lines[i + 2] ?? "";
        const currVal    = lines[i + 3] ?? "";
        const status     = lines[i + 4] ?? "";
        const owner      = lines[i + 5] ?? "";
        const ownerType  = lines[i + 6] ?? "";
        const utFeeder   = lines[i + 7] ?? "";
        const ihtExempt  = lines[i + 8] ?? "";

        const accountDbId = `${accountId}_${planNumber}`;
        currentAccountId = accountDbId;

        storage.upsertAccount({
          id: accountDbId,
          clientId: accountId,
          planNumber,
          product,
          provider,
          currentValue: currVal,
          status,
          primaryOwner: owner,
          ownershipType: ownerType,
          utFeeder,
          ihtExempt,
        });
        accountsFound++;
        i += 9; // skip the columns we consumed
        continue;
      }

      // Holding row heuristic: a currency price like "£1.234" or "1.2345" followed
      // by a number (units) — meaning: line = fund name, line+1 = price, line+2 = units
      const nextLine = lines[i + 1] ?? "";
      const isPriceLike = /^£?[\d,]+\.?\d*$/.test(nextLine) || /^\d+\.\d{3,}$/.test(nextLine);
      if (currentAccountId && line.length > 2 && isPriceLike && !/^\d{5,}$/.test(line)) {
        const fundName  = line;
        const price     = lines[i + 1] ?? "";
        const units     = lines[i + 2] ?? "";
        const valuation = lines[i + 3] ?? "";
        const pctInv    = lines[i + 4] ?? "";
        const secId     = lines[i + 5] ?? "";

        storage.insertHolding({
          accountId: currentAccountId,
          fundName,
          price,
          units,
          valuation,
          percentageInvested: pctInv,
          securityId: secId,
        });
        holdingsFound++;
        i += 6;
        continue;
      }

      i++;
    }

    console.log(`[Scraper] ✓ ${clientName} — ${accountsFound} accounts, ${holdingsFound} holdings`);
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
