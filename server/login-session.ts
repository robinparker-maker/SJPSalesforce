/**
 * Remote login session manager.
 *
 * When SSO login is needed, this launches a headed Playwright browser
 * (non-headless) and streams screenshots to the frontend via SSE.
 * The frontend renders the screenshots and sends click/keyboard events
 * back via POST, which this module replays into the browser.
 *
 * This allows the user to complete SJP SSO login from any web browser,
 * with the actual browser running on the server.
 */

import { chromium, type Browser, type Page } from "playwright";
import type { Response as ExpressResponse } from "express";
import path from "path";
import fs from "fs";
import { saveSession } from "./scraper";

const DATA_DIR = process.env.DATABASE_URL
  ? path.dirname(process.env.DATABASE_URL)
  : process.cwd();
const SESSION_FILE = path.join(DATA_DIR, "session.json");
const BASE_URL = "https://sjp2.lightning.force.com";

interface LoginSession {
  browser: Browser;
  page: Page;
  sseClients: ExpressResponse[];
  streaming: boolean;
  streamInterval: ReturnType<typeof setInterval> | null;
  status: "waiting" | "success" | "error";
}

let activeSession: LoginSession | null = null;

export function hasActiveLoginSession(): boolean {
  return activeSession !== null;
}

export async function startLoginSession(): Promise<void> {
  if (activeSession) {
    await stopLoginSession();
  }

  const browser = await chromium.launch({
    headless: true, // Must be headless in cloud — we stream screenshots instead
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  activeSession = {
    browser,
    page,
    sseClients: [],
    streaming: false,
    streamInterval: null,
    status: "waiting",
  };

  // Navigate to SJP
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Start screenshot streaming
  startStreaming();

  // Watch for successful login
  page.waitForURL("**/lightning/**", { timeout: 180000 })
    .then(async () => {
      await page.waitForTimeout(3000);
      const context = page.context();
      await saveSession(context);
      if (activeSession) activeSession.status = "success";
      broadcastEvent({ type: "login_success" });
      // Keep streaming briefly so user sees the result
      setTimeout(() => stopLoginSession(), 5000);
    })
    .catch(() => {
      if (activeSession) activeSession.status = "error";
      broadcastEvent({ type: "login_error", message: "Login timed out" });
    });
}

function startStreaming() {
  if (!activeSession || activeSession.streaming) return;
  activeSession.streaming = true;

  activeSession.streamInterval = setInterval(async () => {
    if (!activeSession || activeSession.sseClients.length === 0) return;
    try {
      const screenshot = await activeSession.page.screenshot({ type: "jpeg", quality: 75 });
      const b64 = screenshot.toString("base64");
      broadcastEvent({ type: "frame", data: b64 });
    } catch {
      // Page may have navigated — ignore
    }
  }, 300); // ~3fps — enough to see SSO form and interact
}

function broadcastEvent(payload: object) {
  if (!activeSession) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  const dead: ExpressResponse[] = [];
  for (const res of activeSession.sseClients) {
    try {
      res.write(data);
    } catch {
      dead.push(res);
    }
  }
  activeSession.sseClients = activeSession.sseClients.filter(r => !dead.includes(r));
}

export function addSSEClient(res: ExpressResponse) {
  if (!activeSession) return;
  activeSession.sseClients.push(res);
  // Send current status immediately
  res.write(`data: ${JSON.stringify({ type: "status", status: activeSession.status })}\n\n`);
}

export async function sendClick(x: number, y: number) {
  if (!activeSession) return;
  await activeSession.page.mouse.click(x, y);
}

export async function sendType(text: string) {
  if (!activeSession) return;
  await activeSession.page.keyboard.type(text);
}

export async function sendKey(key: string) {
  if (!activeSession) return;
  await activeSession.page.keyboard.press(key as any);
}

export async function stopLoginSession() {
  if (!activeSession) return;
  if (activeSession.streamInterval) clearInterval(activeSession.streamInterval);
  broadcastEvent({ type: "closed" });
  try { await activeSession.browser.close(); } catch {}
  activeSession = null;
}
