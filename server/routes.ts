import type { Express } from "express";
import type { Server } from "http";
import fs from "fs";
import path from "path";
import { storage } from "./storage";
import { runScrape, saveSession, sessionExists, isSessionValid } from "./scraper";
import {
  startLoginSession, addSSEClient, sendClick, sendType, sendKey,
  hasActiveLoginSession, stopLoginSession,
} from "./login-session";

const SESSION_FILE = path.join(process.cwd(), "session.json");
const APP_PASSWORD = process.env.APP_PASSWORD || "sjpportfolio2024";
let scrapeInProgress = false;

// Simple password middleware
function requireAuth(req: any, res: any, next: any) {
  const token = req.headers["x-app-token"] || req.query.token;
  if (token === APP_PASSWORD) return next();
  res.status(401).json({ error: "Unauthorized" });
}

export function registerRoutes(httpServer: Server, app: Express) {

  // ── Public health check (no auth) ───────────────────────────────────────────
  app.get("/health", (_req, res) => res.json({ ok: true }));

  // ── Auth check ──────────────────────────────────────────────────────────────
  app.post("/api/auth", (req, res) => {
    const { password } = req.body;
    if (password === APP_PASSWORD) {
      res.json({ success: true, token: APP_PASSWORD });
    } else {
      res.status(401).json({ success: false, message: "Incorrect password" });
    }
  });

  // ── Session status ──────────────────────────────────────────────────────────
  app.get("/api/session/status", requireAuth, async (_req, res) => {
    if (!sessionExists()) return res.json({ status: "none" });
    const valid = await isSessionValid();
    res.json({ status: valid ? "valid" : "expired" });
  });

  // ── Start remote login session ──────────────────────────────────────────────
  app.post("/api/session/login/start", requireAuth, async (_req, res) => {
    try {
      if (!hasActiveLoginSession()) {
        await startLoginSession();
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── SSE stream of browser screenshots ──────────────────────────────────────
  app.get("/api/session/login/stream", requireAuth, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    addSSEClient(res);
    req.on("close", () => { /* client disconnected */ });
  });

  // ── Send click to remote browser ────────────────────────────────────────────
  app.post("/api/session/login/click", requireAuth, async (req, res) => {
    const { x, y } = req.body;
    await sendClick(x, y);
    res.json({ success: true });
  });

  // ── Send keyboard input to remote browser ───────────────────────────────────
  app.post("/api/session/login/type", requireAuth, async (req, res) => {
    const { text } = req.body;
    await sendType(text);
    res.json({ success: true });
  });

  // ── Send key press ──────────────────────────────────────────────────────────
  app.post("/api/session/login/key", requireAuth, async (req, res) => {
    const { key } = req.body;
    await sendKey(key);
    res.json({ success: true });
  });

  // ── Cancel login session ────────────────────────────────────────────────────
  app.delete("/api/session/login", requireAuth, async (_req, res) => {
    await stopLoginSession();
    res.json({ success: true });
  });

  // ── Delete saved session ────────────────────────────────────────────────────
  app.delete("/api/session", requireAuth, (_req, res) => {
    if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    res.json({ success: true });
  });

  // ── Trigger a full scrape ───────────────────────────────────────────────────
  app.post("/api/scrape", requireAuth, async (_req, res) => {
    if (scrapeInProgress) {
      return res.status(409).json({ success: false, message: "Scrape already in progress." });
    }
    scrapeInProgress = true;
    res.json({ success: true, message: "Scrape started." });
    try {
      await runScrape();
    } finally {
      scrapeInProgress = false;
    }
  });

  // ── Scrape status ───────────────────────────────────────────────────────────
  app.get("/api/scrape/status", requireAuth, (_req, res) => {
    const latest = storage.getLatestScrapeLog();
    res.json({ inProgress: scrapeInProgress, latest: latest ?? null });
  });

  // ── Scrape history ──────────────────────────────────────────────────────────
  app.get("/api/scrape/history", requireAuth, (_req, res) => {
    res.json(storage.getScrapeLogs());
  });

  // ── Get all clients ─────────────────────────────────────────────────────────
  app.get("/api/clients", requireAuth, (_req, res) => {
    res.json(storage.getClients());
  });

  // ── Get one client ──────────────────────────────────────────────────────────
  app.get("/api/clients/:id", requireAuth, (req, res) => {
    const client = storage.getClient(req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    res.json(client);
  });

  // ── Get investment accounts for a client ────────────────────────────────────
  app.get("/api/clients/:id/accounts", requireAuth, (req, res) => {
    const accounts = storage.getAccountsByClient(req.params.id);
    res.json(accounts);
  });

  // ── Get holdings for an account ─────────────────────────────────────────────
  app.get("/api/accounts/:id/holdings", requireAuth, (req, res) => {
    const holdings = storage.getHoldingsByAccount(req.params.id);
    res.json(holdings);
  });

  // ── Full portfolio for a client ─────────────────────────────────────────────
  app.get("/api/clients/:id/portfolio", requireAuth, (req, res) => {
    const client = storage.getClient(req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    const accounts = storage.getAccountsByClient(req.params.id);
    const accountsWithHoldings = accounts.map(acc => ({
      ...acc,
      holdings: storage.getHoldingsByAccount(acc.id),
    }));
    res.json({ client, accounts: accountsWithHoldings });
  });
}
