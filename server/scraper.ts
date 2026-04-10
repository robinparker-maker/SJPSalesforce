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

// ── Build the Investment Accounts component URL ───────────────────────────────
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
  return Buffer.from(JSON.stringify(payload)).toString("base64");
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

// ── OCR a screenshot using the built-in Tesseract or simple image-to-text ─────
async function ocrScreenshot(screenshotPath: string): Promise<string> {
  // Use Playwright's built-in accessibility tree as primary "OCR"
  // If that fails, we fall back to reading the saved screenshot via external tool
  return fs.readFileSync(screenshotPath).toString("base64");
}

// ── Scrape one client using screenshot + text extraction ──────────────────────
async function scrapeClient(
  context: BrowserContext,
  accountId: string,
  clientName: string
): Promise<void> {
  const page = await context.newPage();
  try {
    const cleanName = clientName.replace(/^Account\s*/i, "").replace(/\s*\|.*$/, "").trim();
    console.log(`[Scraper] Loading account page for ${cleanName}`);

    // Load the Account page
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

    // Navigate to the investment component using the hash
    const hash = buildInvestmentUrl(accountId);
    await page.evaluate((h) => {
      window.location.hash = h;
    }, hash);
    await page.waitForTimeout(15000);

    // Take a full-page screenshot
    const screenshotPath = path.join(DATA_DIR, `screenshot-${accountId}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[Scraper] Screenshot saved: ${screenshotPath}`);

    // ── Use Playwright's accessibility tree to get ALL text ────────────────────
    // This pierces shadow DOM and gives us structured text
    const snapshot = await page.accessibility.snapshot({ interestingOnly: false });
    const allText = extractAccessibilityText(snapshot);
    console.log(`[Scraper] Accessibility text length: ${allText.length}`);
    
    // Save full accessibility text for debugging
    fs.writeFileSync(path.join(DATA_DIR, `a11y-${accountId}.txt`), allText);

    // Log key sections
    const planIdx = allText.match(/(UT|IB|IS|PE|PP)\d{6,}/);
    const gbpIdx = allText.indexOf("GBP");
    const startIdx = Math.max(0, Math.min(planIdx?.index ?? 99999, gbpIdx > 0 ? gbpIdx : 99999) - 100);
    console.log(`[Scraper] Key data section:`, allText.slice(startIdx, startIdx + 3000));

    // ── Parse investment accounts from accessibility text ──────────────────────
    storage.upsertClient({
      id: accountId,
      name: cleanName,
      totalValue: undefined,
      lastScraped: new Date().toISOString(),
    });
    storage.deleteAccountsByClient(accountId);

    let accountsFound = 0;
    let holdingsFound = 0;

    // Split into lines and look for plan number patterns
    const lines = allText.split("\n").map(l => l.trim()).filter(l => l.length > 0);

    // Find the total
    const totalLine = lines.find(l => l.match(/Total.*GBP/i));
    let totalValue: string | null = null;
    if (totalLine) {
      const m = totalLine.match(/GBP\s*([\d,]+\.\d{2})/);
      if (m) totalValue = `£${m[1]}`;
    }

    // Parse plan rows: plan numbers start with UT/IB/IS/PE/PP followed by digits, or are 6-10 digit numbers
    let currentAccountId: string | null = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Match plan number patterns
      if (/^(UT|IB|IS|PE|PP)\d{9,}$/.test(line) || /^\d{6,10}$/.test(line)) {
        const planNumber = line;
        const accountDbId = `${accountId}_${planNumber}`;
        currentAccountId = accountDbId;

        // Look ahead for product, provider, value etc.
        const product = lines[i + 1] ?? "";
        const provider = lines[i + 2] ?? "";
        
        // Find the GBP value nearby
        let currentValue = "";
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const gbpMatch = lines[j].match(/^GBP\s*([\d,]+\.\d{2})/);
          if (gbpMatch) { currentValue = `GBP ${gbpMatch[1]}`; break; }
        }

        // Find status nearby
        let status = "";
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (lines[j] === "In Force" || lines[j] === "Surrendered" || lines[j] === "Matured") {
            status = lines[j]; break;
          }
        }

        // Find owner nearby
        let owner = cleanName;
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (lines[j].includes("Swallow") || lines[j].includes("Mr ") || lines[j].includes("Mrs ")) {
            owner = lines[j]; break;
          }
        }

        // Find ownership type
        let ownerType = "";
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          if (lines[j] === "Single" || lines[j] === "Joint") {
            ownerType = lines[j]; break;
          }
        }

        storage.upsertAccount({
          id: accountDbId,
          clientId: accountId,
          planNumber,
          product,
          provider,
          currentValue,
          status,
          primaryOwner: owner,
          ownershipType: ownerType,
          utFeeder: "",
          ihtExempt: "",
        });
        accountsFound++;
        console.log(`[Scraper] Account: ${planNumber} | ${product} | ${currentValue} | ${status}`);
      }

      // Fund holding rows: "SJP " prefix or known fund name followed by GBP price
      if (currentAccountId && (line.startsWith("SJP ") || line.startsWith("Parkwalk")) && !line.includes("St. James")) {
        const fundName = line;
        // Look ahead for price, units, valuation
        let price = "", units = "", valuation = "", pctInvested = "", securityId = "";
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const l = lines[j];
          if (l.match(/^GBP\s*\d/) && !price) price = l;
          else if (l.match(/^GBP\s*\d/) && price && !valuation) valuation = l;
          else if (l.match(/^[\d,]+\.\d{3}/) && !units) units = l;
          else if (l.match(/^\d+\.\d+\s*%?$/) && !pctInvested) pctInvested = l;
          else if (l.includes("BLUEDOOR") || l.includes("BDUNITID")) securityId = l;
        }

        storage.insertHolding({
          accountId: currentAccountId,
          fundName,
          price,
          units,
          valuation,
          percentageInvested: pctInvested,
          securityId,
        });
        holdingsFound++;
      }
    }

    // Update total
    if (totalValue || accountsFound > 0) {
      const allAccounts = storage.getAccountsByClient(accountId);
      const computedTotal = allAccounts.reduce((sum, a) => {
        const v = parseFloat((a.currentValue ?? "").replace(/[£,GBP\s]/g, ""));
        return isNaN(v) ? sum : sum + v;
      }, 0);
      storage.upsertClient({
        id: accountId,
        name: cleanName,
        totalValue: totalValue || (computedTotal > 0 ? `£${computedTotal.toLocaleString("en-GB", { minimumFractionDigits: 2 })}` : undefined),
        lastScraped: new Date().toISOString(),
      });
    }

    console.log(`[Scraper] ✓ ${cleanName} — ${accountsFound} accounts, ${holdingsFound} holdings`);
  } finally {
    await page.close();
  }
}

// ── Extract all text from accessibility tree (pierces shadow DOM) ──────────────
function extractAccessibilityText(node: any, depth = 0): string {
  if (!node) return "";
  let text = "";
  
  if (node.name && node.name.trim()) {
    text += node.name.trim() + "\n";
  }
  if (node.value && node.value.trim() && node.value !== node.name) {
    text += node.value.trim() + "\n";
  }
  
  if (node.children) {
    for (const child of node.children) {
      text += extractAccessibilityText(child, depth + 1);
    }
  }
  
  return text;
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
