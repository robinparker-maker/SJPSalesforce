import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { eq, desc } from "drizzle-orm";
import {
  clients, investmentAccounts, fundHoldings, scrapeLog,
  type Client, type InvestmentAccount, type FundHolding, type ScrapeLog,
  type InsertClient, type InsertAccount, type InsertHolding,
} from "@shared/schema";

const dbPath = process.env.DATABASE_URL || "sjp_data.db";
const sqlite = new Database(dbPath);
export const db = drizzle(sqlite);

// ── Init Tables ───────────────────────────────────────────────────────────────
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    total_value TEXT,
    last_scraped TEXT
  );
  CREATE TABLE IF NOT EXISTS investment_accounts (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(id),
    plan_number TEXT NOT NULL,
    product TEXT,
    provider TEXT,
    current_value TEXT,
    status TEXT,
    primary_owner TEXT,
    ownership_type TEXT,
    ut_feeder TEXT,
    iht_exempt TEXT
  );
  CREATE TABLE IF NOT EXISTS fund_holdings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES investment_accounts(id),
    fund_name TEXT,
    price TEXT,
    units TEXT,
    valuation TEXT,
    percentage_invested TEXT,
    security_id TEXT
  );
  CREATE TABLE IF NOT EXISTS scrape_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    clients_scraped INTEGER DEFAULT 0,
    error_message TEXT
  );
`);

export interface IStorage {
  // Clients
  getClients(): Client[];
  getClient(id: string): Client | undefined;
  upsertClient(client: InsertClient): Client;

  // Accounts
  getAccountsByClient(clientId: string): InvestmentAccount[];
  upsertAccount(account: InsertAccount): InvestmentAccount;
  deleteAccountsByClient(clientId: string): void;

  // Holdings
  getHoldingsByAccount(accountId: string): FundHolding[];
  insertHolding(holding: InsertHolding): FundHolding;
  deleteHoldingsByAccount(accountId: string): void;

  // Scrape log
  getLatestScrapeLog(): ScrapeLog | undefined;
  getScrapeLogs(): ScrapeLog[];
  createScrapeLog(log: { startedAt: string; status: string }): ScrapeLog;
  updateScrapeLog(id: number, updates: Partial<ScrapeLog>): ScrapeLog;
}

class Storage implements IStorage {
  getClients(): Client[] {
    return db.select().from(clients).all();
  }

  getClient(id: string): Client | undefined {
    return db.select().from(clients).where(eq(clients.id, id)).get();
  }

  upsertClient(client: InsertClient): Client {
    return db.insert(clients).values(client)
      .onConflictDoUpdate({ target: clients.id, set: client })
      .returning().get();
  }

  getAccountsByClient(clientId: string): InvestmentAccount[] {
    return db.select().from(investmentAccounts)
      .where(eq(investmentAccounts.clientId, clientId)).all();
  }

  upsertAccount(account: InsertAccount): InvestmentAccount {
    return db.insert(investmentAccounts).values(account)
      .onConflictDoUpdate({ target: investmentAccounts.id, set: account })
      .returning().get();
  }

  deleteAccountsByClient(clientId: string): void {
    // First delete all holdings for this client's accounts
    const accounts = this.getAccountsByClient(clientId);
    for (const acc of accounts) {
      this.deleteHoldingsByAccount(acc.id);
    }
    db.delete(investmentAccounts).where(eq(investmentAccounts.clientId, clientId)).run();
  }

  getHoldingsByAccount(accountId: string): FundHolding[] {
    return db.select().from(fundHoldings)
      .where(eq(fundHoldings.accountId, accountId)).all();
  }

  insertHolding(holding: InsertHolding): FundHolding {
    return db.insert(fundHoldings).values(holding).returning().get();
  }

  deleteHoldingsByAccount(accountId: string): void {
    db.delete(fundHoldings).where(eq(fundHoldings.accountId, accountId)).run();
  }

  getLatestScrapeLog(): ScrapeLog | undefined {
    return db.select().from(scrapeLog).orderBy(desc(scrapeLog.id)).limit(1).get();
  }

  getScrapeLogs(): ScrapeLog[] {
    return db.select().from(scrapeLog).orderBy(desc(scrapeLog.id)).limit(20).all();
  }

  createScrapeLog(log: { startedAt: string; status: string }): ScrapeLog {
    return db.insert(scrapeLog).values(log).returning().get();
  }

  updateScrapeLog(id: number, updates: Partial<ScrapeLog>): ScrapeLog {
    return db.update(scrapeLog).set(updates).where(eq(scrapeLog.id, id)).returning().get();
  }
}

export const storage = new Storage();
