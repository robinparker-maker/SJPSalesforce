import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Clients ──────────────────────────────────────────────────────────────────
export const clients = sqliteTable("clients", {
  id: text("id").primaryKey(),           // Salesforce Account ID
  name: text("name").notNull(),
  totalValue: text("total_value"),       // e.g. "£2,279,890.53"
  lastScraped: text("last_scraped"),     // ISO timestamp
});

// ── Investment Accounts ───────────────────────────────────────────────────────
export const investmentAccounts = sqliteTable("investment_accounts", {
  id: text("id").primaryKey(),           // planNumber used as ID
  clientId: text("client_id").notNull().references(() => clients.id),
  planNumber: text("plan_number").notNull(),
  product: text("product"),
  provider: text("provider"),
  currentValue: text("current_value"),
  status: text("status"),
  primaryOwner: text("primary_owner"),
  ownershipType: text("ownership_type"),
  utFeeder: text("ut_feeder"),
  ihtExempt: text("iht_exempt"),
});

// ── Fund Holdings ─────────────────────────────────────────────────────────────
export const fundHoldings = sqliteTable("fund_holdings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: text("account_id").notNull().references(() => investmentAccounts.id),
  fundName: text("fund_name"),
  price: text("price"),
  units: text("units"),
  valuation: text("valuation"),
  percentageInvested: text("percentage_invested"),
  securityId: text("security_id"),
});

// ── Scrape Log ────────────────────────────────────────────────────────────────
export const scrapeLog = sqliteTable("scrape_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  status: text("status").notNull(),     // "running" | "success" | "error"
  clientsScraped: integer("clients_scraped").default(0),
  errorMessage: text("error_message"),
});

// ── Zod Schemas ───────────────────────────────────────────────────────────────
export const insertClientSchema = createInsertSchema(clients);
export const insertAccountSchema = createInsertSchema(investmentAccounts);
export const insertHoldingSchema = createInsertSchema(fundHoldings).omit({ id: true });
export const insertScrapeLogSchema = createInsertSchema(scrapeLog).omit({ id: true });

export type Client = typeof clients.$inferSelect;
export type InvestmentAccount = typeof investmentAccounts.$inferSelect;
export type FundHolding = typeof fundHoldings.$inferSelect;
export type ScrapeLog = typeof scrapeLog.$inferSelect;
export type InsertClient = z.infer<typeof insertClientSchema>;
export type InsertAccount = z.infer<typeof insertAccountSchema>;
export type InsertHolding = z.infer<typeof insertHoldingSchema>;
