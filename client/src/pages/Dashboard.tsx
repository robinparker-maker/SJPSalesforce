import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, setAppToken, getAppToken, getAuthHeaders } from "@/lib/queryClient";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Client, ScrapeLog } from "@shared/schema";

// ─── Logo ───────────────────────────────────────────────────────────────────
function Logo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-label="SJP Portfolio" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="6" fill="hsl(43 90% 52%)"/>
      <path d="M8 12h16M8 16h10M8 20h13" stroke="hsl(222 28% 7%)" strokeWidth="2.5" strokeLinecap="round"/>
      <circle cx="24" cy="20" r="3" fill="hsl(222 28% 7%)"/>
    </svg>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function formatCurrency(val: string | null | undefined) {
  if (!val) return "—";
  return val.replace("GBP", "£").replace("  ", " ");
}

function ScrapeStatusBadge({ log }: { log: ScrapeLog | null }) {
  if (!log) return <Badge variant="secondary">Never run</Badge>;
  if (log.status === "running") return <Badge className="bg-yellow-600 text-white">Running…</Badge>;
  if (log.status === "success") return <Badge className="bg-green-700 text-white">Last sync: {new Date(log.completedAt!).toLocaleString("en-GB")}</Badge>;
  return <Badge variant="destructive">Error</Badge>;
}

// ─── Password Gate ────────────────────────────────────────────────────────────
function PasswordGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (data.success) {
        setAppToken(data.token);
        onAuthenticated();
      } else {
        setError("Incorrect password. Please try again.");
      }
    } catch {
      setError("Could not connect to server.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Logo />
          <div className="text-center">
            <h1 className="text-xl font-semibold text-foreground">SJP Portfolio</h1>
            <p className="text-sm text-muted-foreground mt-1">Enter your access password to continue</p>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoFocus
            data-testid="input-app-password"
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || !password}>
            {loading ? "Checking…" : "Continue"}
          </Button>
        </form>
      </div>
    </div>
  );
}

// ─── Remote Browser Modal ─────────────────────────────────────────────────────
function RemoteBrowserModal({
  open,
  onClose,
  onLoginSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onLoginSuccess: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [status, setStatus] = useState<"connecting" | "streaming" | "success" | "error">("connecting");
  const [statusMessage, setStatusMessage] = useState("Launching browser…");
  const { toast } = useToast();

  // Natural browser dimensions (what the server renders at)
  const BROWSER_W = 1280;
  const BROWSER_H = 800;

  // Start session and SSE stream
  useEffect(() => {
    if (!open) return;

    let es: EventSource | null = null;

    const start = async () => {
      setStatus("connecting");
      setStatusMessage("Launching browser…");

      // Start the server-side browser
      try {
        await apiRequest("POST", "/api/session/login/start");
      } catch (err: any) {
        setStatus("error");
        setStatusMessage("Failed to start browser: " + err.message);
        return;
      }

      // Connect SSE stream - we need the token in the URL since EventSource can't set headers
      const token = getAppToken();
      const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
      const streamUrl = `${API_BASE}/api/session/login/stream?token=${encodeURIComponent(token || "")}`;
      es = new EventSource(streamUrl);
      eventSourceRef.current = es;

      es.onopen = () => {
        setStatus("streaming");
        setStatusMessage("Complete your SJP login below");
      };

      es.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "frame") {
            drawFrame(msg.data);
          } else if (msg.type === "login_success") {
            setStatus("success");
            setStatusMessage("Login successful!");
            toast({ title: "Logged in", description: "SJP session saved. You can now sync data." });
            setTimeout(() => {
              onLoginSuccess();
              onClose();
            }, 1500);
          } else if (msg.type === "login_error") {
            setStatus("error");
            setStatusMessage(msg.message || "Login failed");
          } else if (msg.type === "closed") {
            if (status !== "success") {
              setStatus("error");
              setStatusMessage("Browser session closed");
            }
          } else if (msg.type === "status") {
            if (msg.status === "success") {
              setStatus("success");
            }
          }
        } catch {/* ignore parse errors */}
      };

      es.onerror = () => {
        if (status !== "success") {
          setStatus("streaming"); // reconnecting is normal — don't flash error
        }
      };
    };

    start();

    return () => {
      es?.close();
      eventSourceRef.current = null;
    };
  }, [open]);

  function drawFrame(b64: string) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = "data:image/jpeg;base64," + b64;
  }

  // Map canvas click to browser coordinates
  const handleCanvasClick = useCallback(async (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || status !== "streaming") return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = BROWSER_W / rect.width;
    const scaleY = BROWSER_H / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    try {
      await apiRequest("POST", "/api/session/login/click", { x, y });
    } catch {/* ignore */}
  }, [status]);

  // Keyboard input when canvas is focused
  const handleKeyDown = useCallback(async (e: React.KeyboardEvent) => {
    if (status !== "streaming") return;
    e.preventDefault();

    // Special keys
    const specialKeys: Record<string, string> = {
      Enter: "Enter", Backspace: "Backspace", Tab: "Tab", Escape: "Escape",
      ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
      Delete: "Delete", Home: "Home", End: "End",
    };

    if (specialKeys[e.key]) {
      try {
        await apiRequest("POST", "/api/session/login/key", { key: specialKeys[e.key] });
      } catch {/* ignore */}
    } else if (e.key.length === 1) {
      try {
        await apiRequest("POST", "/api/session/login/type", { text: e.key });
      } catch {/* ignore */}
    }
  }, [status]);

  const handleClose = async () => {
    eventSourceRef.current?.close();
    try { await apiRequest("DELETE", "/api/session/login"); } catch {/* ignore */}
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={val => { if (!val) handleClose(); }}>
      <DialogContent className="max-w-4xl w-full p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="text-sm font-medium flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                status === "streaming" ? "bg-green-500" :
                status === "success" ? "bg-green-600" :
                status === "error" ? "bg-red-500" : "bg-yellow-500"
              }`}
            />
            SJP Login — {statusMessage}
          </DialogTitle>
        </DialogHeader>

        <div className="relative bg-black" ref={containerRef}>
          {/* Browser canvas — click to interact, type to type */}
          <canvas
            ref={canvasRef}
            width={BROWSER_W}
            height={BROWSER_H}
            onClick={handleCanvasClick}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            className="w-full block focus:outline-none"
            style={{
              cursor: status === "streaming" ? "default" : "not-allowed",
              maxHeight: "70vh",
              objectFit: "contain",
            }}
            title="Click and type to interact with the browser"
          />

          {/* Overlay when not streaming */}
          {status !== "streaming" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60">
              <div className="text-center text-white space-y-2">
                {status === "connecting" && (
                  <>
                    <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin mx-auto" />
                    <p className="text-sm">{statusMessage}</p>
                  </>
                )}
                {status === "success" && (
                  <p className="text-green-400 font-medium text-lg">{statusMessage}</p>
                )}
                {status === "error" && (
                  <div className="space-y-3">
                    <p className="text-red-400 text-sm">{statusMessage}</p>
                    <Button size="sm" variant="outline" onClick={handleClose}>Close</Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {status === "streaming" && (
          <div className="px-4 py-2 border-t border-border bg-muted/30">
            <p className="text-xs text-muted-foreground">
              Click on the browser above to interact. Type to enter text. Complete the SJP SSO login — your session will be saved automatically.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const qc = useQueryClient();
  const { toast } = useToast();

  // App-level auth state
  const [authenticated, setAuthenticated] = useState(() => !!getAppToken());
  const [showLoginModal, setShowLoginModal] = useState(false);

  // Queries — only run when authenticated
  const { data: clients = [], isLoading: loadingClients } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
    enabled: authenticated,
  });

  const { data: scrapeStatus } = useQuery<{ inProgress: boolean; latest: ScrapeLog | null }>({
    queryKey: ["/api/scrape/status"],
    enabled: authenticated,
    refetchInterval: (data) => (data?.state?.data?.inProgress ? 3000 : false),
  });

  const { data: sessionStatus, refetch: refetchSession } = useQuery<{ status: string }>({
    queryKey: ["/api/session/status"],
    enabled: authenticated,
  });

  const scrapeMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/scrape"),
    onSuccess: () => {
      toast({ title: "Sync started", description: "Fetching all client data from SJP…" });
      qc.invalidateQueries({ queryKey: ["/api/scrape/status"] });
    },
    onError: () => toast({ title: "Error", description: "Could not start sync.", variant: "destructive" }),
  });

  const totalAUM = clients.reduce((sum, c) => {
    const val = c.totalValue?.replace(/[£,\s]/g, "");
    const n = parseFloat(val ?? "");
    return isNaN(n) ? sum : sum + n;
  }, 0);

  const sessionOk = sessionStatus?.status === "valid";

  // Show password gate until authenticated
  if (!authenticated) {
    return (
      <PasswordGate
        onAuthenticated={() => {
          setAuthenticated(true);
          // Invalidate everything so queries re-fire with token
          qc.invalidateQueries();
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Remote browser modal */}
      <RemoteBrowserModal
        open={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onLoginSuccess={() => {
          refetchSession();
          qc.invalidateQueries({ queryKey: ["/api/session/status"] });
        }}
      />

      {/* Header */}
      <header className="border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold text-foreground tracking-tight">SJP Portfolio</h1>
            <p className="text-xs text-muted-foreground">Investment Data Dashboard</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ScrapeStatusBadge log={scrapeStatus?.latest ?? null} />
          {!sessionOk ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowLoginModal(true)}
              data-testid="button-login"
            >
              Login to SJP
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => scrapeMutation.mutate()}
              disabled={scrapeMutation.isPending || scrapeStatus?.inProgress}
              data-testid="button-sync"
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {scrapeStatus?.inProgress ? "Syncing…" : "Sync All Clients"}
            </Button>
          )}
        </div>
      </header>

      <main className="px-6 py-6 max-w-6xl mx-auto space-y-6">

        {/* KPI row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider">Total Clients</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold tabular-nums">{loadingClients ? "—" : clients.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider">Total AUM</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold tabular-nums text-primary">
                {loadingClients ? "—" : totalAUM > 0 ? `£${totalAUM.toLocaleString("en-GB", { minimumFractionDigits: 2 })}` : "—"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1">
              <CardTitle className="text-xs text-muted-foreground uppercase tracking-wider">Last Updated</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm tabular-nums text-muted-foreground">
                {scrapeStatus?.latest?.completedAt
                  ? new Date(scrapeStatus.latest.completedAt).toLocaleString("en-GB")
                  : "Never synced"}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Session warning */}
        {sessionStatus && !sessionOk && (
          <Card className="border-yellow-700/50 bg-yellow-950/20">
            <CardContent className="py-4 text-sm text-yellow-400 flex items-center justify-between gap-4">
              <span>
                {sessionStatus.status === "none"
                  ? "No SJP session found. Click \"Login to SJP\" to authenticate via the remote browser."
                  : "Your SJP session has expired. Click \"Login to SJP\" to re-authenticate."}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="border-yellow-700 text-yellow-400 hover:bg-yellow-900/20 shrink-0"
                onClick={() => setShowLoginModal(true)}
              >
                Login to SJP
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Client list */}
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Clients</h2>
          {loadingClients ? (
            <div className="space-y-2">
              {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
            </div>
          ) : clients.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-muted-foreground">
                <p className="text-sm">No client data yet.</p>
                <p className="text-xs mt-1">Log in and click "Sync All Clients" to fetch data from SJP.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {clients.map(client => (
                <Link href={`/client/${client.id}`} key={client.id}>
                  <Card
                    className="cursor-pointer hover:border-primary/50 transition-colors"
                    data-testid={`card-client-${client.id}`}
                  >
                    <CardContent className="py-4 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-foreground">{client.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Last synced: {client.lastScraped
                            ? new Date(client.lastScraped).toLocaleString("en-GB")
                            : "Never"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-bold tabular-nums text-primary">
                          {formatCurrency(client.totalValue)}
                        </p>
                        <p className="text-xs text-muted-foreground">Total portfolio</p>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
