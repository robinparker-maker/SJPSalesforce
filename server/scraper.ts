import { chromium, type BrowserContext } from "playwright";
import fs from "fs";
import path from "path";
import { storage } from "./storage";

const BASE_URL = "https://sjp2.lightning.force.com";
const DATA_DIR = process.env.DATABASE_URL
  ? path.dirname(process.env.DATABASE_URL)
  : process.cwd();
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const REPORT_ID = "00OTu00000SMtP7MAL";
const REPORT_URL = `${BASE_URL}/lightning/r/Report/${REPORT_ID}/view?queryScope=userFoldersSharedWithMe`;

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

// ── Export the Salesforce report and parse it ─────────────────────────────────
async function exportReport(context: BrowserContext): Promise<string | null> {
  const page = await context.newPage();
  try {
    console.log(`[Scraper] Loading report page`);
    await page.goto(REPORT_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(12000);

    // Detect SSO redirect
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (bodyText.includes("Use your password instead") || bodyText.includes("Sign in") || bodyText.length < 300) {
      console.log(`[Scraper] Session expired — SSO login page detected`);
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
      throw new Error("SJP session expired. Please click 'Re-login to SJP' and complete SSO again.");
    }

    // Click the dropdown/actions menu to find Export
    // Salesforce reports have a dropdown arrow or "Export" button
    const exportSelectors = [
      'button[title="Export"]',
      'button:has-text("Export")',
      'a:has-text("Export")',
      'button[title="Actions for this report"]',
      'button[title="Report actions"]',
      'lightning-button-menu button',
    ];

    let exportClicked = false;
    for (const sel of exportSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 3000 })) {
          await btn.click();
          console.log(`[Scraper] Clicked: ${sel}`);
          exportClicked = true;
          await page.waitForTimeout(2000);
          break;
        }
      } catch {}
    }

    if (!exportClicked) {
      // Try the kebab/three-dot menu
      console.log(`[Scraper] Looking for report actions menu`);
      const menuBtns = page.locator('button[class*="menu"], button[title*="action"], button[title*="more"]');
      const count = await menuBtns.count();
      console.log(`[Scraper] Found ${count} menu buttons`);
      for (let i = 0; i < count; i++) {
        try {
          await menuBtns.nth(i).click();
          await page.waitForTimeout(1000);
          // Look for Export menu item
          const exportItem = page.locator('a:has-text("Export"), span:has-text("Export"), lightning-menu-item:has-text("Export")').first();
          if (await exportItem.isVisible({ timeout: 2000 })) {
            await exportItem.click();
            exportClicked = true;
            console.log(`[Scraper] Clicked Export from menu`);
            await page.waitForTimeout(2000);
            break;
          }
        } catch {}
      }
    }

    if (!exportClicked) {
      console.log(`[Scraper] Could not find Export button — taking screenshot for debug`);
      await page.screenshot({ path: path.join(DATA_DIR, `debug-report.png`), fullPage: false });
      // Log visible buttons
      const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, a[role="button"], lightning-button'))
          .map(b => ({ text: (b as HTMLElement).innerText?.trim().slice(0, 60), title: b.getAttribute('title') }))
          .filter(b => b.text || b.title);
      });
      console.log(`[Scraper] Visible buttons:`, JSON.stringify(buttons));
      return null;
    }

    // Handle the Export dialog — select format and download
    // Wait for the export modal
    await page.waitForTimeout(3000);

    // Look for "Formatted Report" or "Details Only" radio, and format selector
    const detailsOnly = page.locator('input[value="details"], label:has-text("Details Only"), span:has-text("Details Only")').first();
    try {
      if (await detailsOnly.isVisible({ timeout: 3000 })) {
        await detailsOnly.click();
        console.log(`[Scraper] Selected "Details Only"`);
      }
    } catch {}

    // Select CSV or Excel format
    const csvOption = page.locator('input[value="csv"], label:has-text(".csv"), span:has-text(".csv")').first();
    const xlsxOption = page.locator('input[value="xlsx"], label:has-text(".xlsx"), span:has-text(".xlsx")').first();
    try {
      if (await csvOption.isVisible({ timeout: 2000 })) {
        await csvOption.click();
        console.log(`[Scraper] Selected CSV format`);
      } else if (await xlsxOption.isVisible({ timeout: 2000 })) {
        await xlsxOption.click();
        console.log(`[Scraper] Selected XLSX format`);
      }
    } catch {}

    // Click the Export/OK/Download button
    const downloadButton = page.locator('button:has-text("Export"), button:has-text("OK"), button:has-text("Download")').first();
    
    // Set up download handler
    const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    
    try {
      await downloadButton.click();
      console.log(`[Scraper] Clicked download button`);
    } catch {
      console.log(`[Scraper] Could not click download button`);
      return null;
    }

    // Wait for download
    const download = await downloadPromise;
    const downloadPath = path.join(DATA_DIR, `report-export.csv`);
    await download.saveAs(downloadPath);
    console.log(`[Scraper] Report downloaded to: ${downloadPath}`);
    return downloadPath;
  } finally {
    await page.close();
  }
}

// ── Parse the exported report (CSV or XLSX) ───────────────────────────────────
function parseReport(filePath: string): void {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length < 2) {
    console.log(`[Scraper] Report file is empty or has no data rows`);
    return;
  }

  // Parse CSV — handle quoted fields
  function parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        inQuotes = !inQuotes;
      } else if (c === "," && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += c;
      }
    }
    result.push(current.trim());
    return result;
  }

  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, ""));
  console.log(`[Scraper] CSV headers: ${headers.join(" | ")}`);

  // Find column indices
  const colMap: Record<string, number> = {};
  const findCol = (names: string[]): number => {
    for (const name of names) {
      const idx = headers.findIndex(h => h.includes(name));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  colMap.owner = findCol(["primary owner", "owner"]);
  colMap.planNumber = findCol(["plan number", "plan"]);
  colMap.servicingPartner = findCol(["servicing partner"]);
  colMap.partnerCode = findCol(["partner/practice", "practice code"]);
  colMap.provider = findCol(["provider"]);
  colMap.currentValueConverted = findCol(["current value (converted)", "current value"]);
  colMap.currentValue = findCol(["current value"]);
  colMap.product = findCol(["product"]);
  colMap.commencementDate = findCol(["commencement date"]);
  colMap.contributions = findCol(["contributions made"]);
  colMap.recordType = findCol(["record type"]);
  colMap.amountContributed = findCol(["amount contributed"]);

  console.log(`[Scraper] Column mapping:`, JSON.stringify(colMap));

  // Parse data rows — skip header, subtotals, and count rows
  const clients = new Map<string, { accounts: any[] }>();

  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    if (cells.length < 3) continue;

    // Skip subtotal and count rows
    const first = cells[0]?.toLowerCase() || "";
    if (first.includes("subtotal") || first.includes("count") || first.includes("grand total")) continue;

    const owner = cells[colMap.owner] ?? "";
    const planNumber = cells[colMap.planNumber] ?? "";
    if (!planNumber || !owner) continue;
    // Skip if plan number looks like a subtotal
    if (planNumber.toLowerCase().includes("sum") || planNumber.toLowerCase().includes("count")) continue;

    const currentValue = cells[colMap.currentValueConverted] ?? cells[colMap.currentValue] ?? "";
    const product = cells[colMap.product] ?? "";
    const provider = cells[colMap.provider] ?? "";

    if (!clients.has(owner)) {
      clients.set(owner, { accounts: [] });
    }

    clients.get(owner)!.accounts.push({
      planNumber,
      provider,
      currentValue,
      product,
      servicingPartner: cells[colMap.servicingPartner] ?? "",
      partnerCode: cells[colMap.partnerCode] ?? "",
      commencementDate: cells[colMap.commencementDate] ?? "",
      recordType: cells[colMap.recordType] ?? "",
      contributions: cells[colMap.contributions] ?? "",
      amountContributed: cells[colMap.amountContributed] ?? "",
    });
  }

  console.log(`[Scraper] Parsed ${clients.size} clients from report`);

  // Save to database
  for (const [ownerName, data] of clients) {
    // Generate a stable client ID from the owner name
    const clientId = Buffer.from(ownerName).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 18);

    // Sum account values for total
    const totalValue = data.accounts.reduce((sum, a) => {
      const v = parseFloat((a.currentValue || "").replace(/[£,GBP\s]/g, ""));
      return isNaN(v) ? sum : sum + v;
    }, 0);

    storage.upsertClient({
      id: clientId,
      name: ownerName,
      totalValue: totalValue > 0 ? `£${totalValue.toLocaleString("en-GB", { minimumFractionDigits: 2 })}` : undefined,
      lastScraped: new Date().toISOString(),
    });

    storage.deleteAccountsByClient(clientId);

    for (const account of data.accounts) {
      const accountDbId = `${clientId}_${account.planNumber}`;
      storage.upsertAccount({
        id: accountDbId,
        clientId,
        planNumber: account.planNumber,
        product: account.product,
        provider: account.provider,
        currentValue: account.currentValue,
        status: "In Force",
        primaryOwner: ownerName,
        ownershipType: "",
        utFeeder: "",
        ihtExempt: "",
      });
    }

    console.log(`[Scraper] ✓ ${ownerName} — ${data.accounts.length} accounts, total £${totalValue.toLocaleString("en-GB")}`);
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

    // Export the report
    const reportPath = await exportReport(context);

    if (reportPath) {
      parseReport(reportPath);
    } else {
      console.log(`[Scraper] Report export failed — no file downloaded`);
    }

    await browser.close();

    const clients = storage.getClients();
    storage.updateScrapeLog(logEntry.id, {
      status: "success",
      completedAt: new Date().toISOString(),
      clientsScraped: clients.length,
    });

    return { success: true, message: `Synced ${clients.length} client(s) from report.` };
  } catch (err: any) {
    storage.updateScrapeLog(logEntry.id, {
      status: "error",
      completedAt: new Date().toISOString(),
      errorMessage: err.message,
    });
    return { success: false, message: err.message };
  }
}
