import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import type { Client, InvestmentAccount, FundHolding } from "@shared/schema";

interface Portfolio {
  client: Client;
  accounts: (InvestmentAccount & { holdings: FundHolding[] })[];
}

function formatValue(val: string | null | undefined) {
  if (!val) return "—";
  return val.replace("GBP", "£").trim();
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const isActive = status.toLowerCase().includes("force") || status.toLowerCase() === "active";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
      isActive ? "bg-green-900/60 text-green-400" : "bg-muted text-muted-foreground"
    }`}>
      {status}
    </span>
  );
}

function HoldingsTable({ holdings }: { holdings: FundHolding[] }) {
  if (holdings.length === 0) return (
    <p className="text-xs text-muted-foreground px-4 py-3">No fund holdings recorded.</p>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs holdings-row">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left px-4 py-2 text-muted-foreground font-medium">Fund / Asset</th>
            <th className="text-right px-4 py-2 text-muted-foreground font-medium">Price</th>
            <th className="text-right px-4 py-2 text-muted-foreground font-medium">Units</th>
            <th className="text-right px-4 py-2 text-muted-foreground font-medium">Valuation</th>
            <th className="text-right px-4 py-2 text-muted-foreground font-medium">% Invested</th>
            <th className="text-left px-4 py-2 text-muted-foreground font-medium">Security ID</th>
          </tr>
        </thead>
        <tbody>
          {holdings.map((h, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-accent/30 transition-colors">
              <td className="px-4 py-2 text-foreground font-medium">{h.fundName || "—"}</td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{formatValue(h.price)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">{h.units || "—"}</td>
              <td className="px-4 py-2 text-right tabular-nums font-semibold text-foreground">{formatValue(h.valuation)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-primary">{h.percentageInvested || "—"}</td>
              <td className="px-4 py-2 text-muted-foreground font-mono text-xs">{h.securityId || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountRow({ account }: { account: InvestmentAccount & { holdings: FundHolding[] } }) {
  const [expanded, setExpanded] = useState(false);
  const hasHoldings = account.holdings.length > 0;

  return (
    <div className="border border-border rounded-lg overflow-hidden mb-2">
      {/* Account header row */}
      <div
        className={`flex items-center gap-3 px-4 py-3 bg-card hover:bg-accent/20 transition-colors ${hasHoldings ? "cursor-pointer" : ""}`}
        onClick={() => hasHoldings && setExpanded(e => !e)}
        data-testid={`row-account-${account.id}`}
      >
        {/* Expand toggle */}
        <button
          className={`text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""} ${!hasHoldings ? "opacity-20 cursor-default" : ""}`}
          disabled={!hasHoldings}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </button>

        {/* Plan number */}
        <span className="text-primary font-mono text-sm font-semibold w-36 shrink-0">{account.planNumber}</span>

        {/* Product */}
        <span className="text-foreground text-sm flex-1 min-w-0 truncate">{account.product || "—"}</span>

        {/* Provider */}
        <span className="text-muted-foreground text-sm w-36 shrink-0 hidden md:block">{account.provider || "—"}</span>

        {/* Value */}
        <span className="text-foreground font-bold tabular-nums text-sm w-36 text-right shrink-0">
          {formatValue(account.currentValue)}
        </span>

        {/* Status */}
        <div className="w-20 shrink-0 flex justify-end">
          <StatusBadge status={account.status} />
        </div>

        {/* Ownership type */}
        <span className="text-muted-foreground text-xs w-16 text-right shrink-0 hidden lg:block">
          {account.ownershipType || "—"}
        </span>

        {/* Badges */}
        <div className="flex gap-1 shrink-0">
          {account.utFeeder === "Yes" && (
            <span className="text-xs bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded">UT</span>
          )}
          {account.ihtExempt === "Yes" && (
            <span className="text-xs bg-purple-900/50 text-purple-300 px-1.5 py-0.5 rounded">IHT</span>
          )}
        </div>
      </div>

      {/* Holdings sub-table */}
      {expanded && hasHoldings && (
        <div className="bg-muted/30 border-t border-border">
          <HoldingsTable holdings={account.holdings} />
        </div>
      )}
    </div>
  );
}

export default function ClientPortfolio() {
  const { id } = useParams<{ id: string }>();

  const { data: portfolio, isLoading } = useQuery<Portfolio>({
    queryKey: ["/api/clients", id, "portfolio"],
    queryFn: () => fetch(`/api/clients/${id}/portfolio`).then(r => r.json()),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-20 w-full" />
        {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
      </div>
    );
  }

  if (!portfolio) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Client not found.</p>
      </div>
    );
  }

  const { client, accounts } = portfolio;

  // Totals
  const totalAccounts = accounts.length;
  const totalHoldings = accounts.reduce((s, a) => s + a.holdings.length, 0);
  const inForce = accounts.filter(a => a.status?.toLowerCase().includes("force")).length;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                ← All Clients
              </Button>
            </Link>
            <div className="w-px h-5 bg-border" />
            <div>
              <h1 className="text-lg font-semibold text-foreground">{client.name}</h1>
              <p className="text-xs text-muted-foreground">
                Last synced: {client.lastScraped ? new Date(client.lastScraped).toLocaleString("en-GB") : "Never"}
              </p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold tabular-nums text-primary">{formatValue(client.totalValue)}</p>
            <p className="text-xs text-muted-foreground">Total portfolio value</p>
          </div>
        </div>
      </header>

      <main className="px-6 py-6 max-w-7xl mx-auto space-y-6">

        {/* KPI strip */}
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Investment Accounts</p>
              <p className="text-2xl font-bold tabular-nums mt-1">{totalAccounts}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">In Force</p>
              <p className="text-2xl font-bold tabular-nums mt-1 text-green-400">{inForce}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Fund Holdings</p>
              <p className="text-2xl font-bold tabular-nums mt-1">{totalHoldings}</p>
            </CardContent>
          </Card>
        </div>

        {/* Column headers */}
        <div className="flex items-center gap-3 px-4 text-xs text-muted-foreground font-medium uppercase tracking-wider border-b border-border pb-2">
          <span className="w-4 shrink-0" />
          <span className="w-36 shrink-0">Plan Number</span>
          <span className="flex-1">Product</span>
          <span className="w-36 shrink-0 hidden md:block">Provider</span>
          <span className="w-36 text-right shrink-0">Current Value</span>
          <span className="w-20 text-right shrink-0">Status</span>
          <span className="w-16 text-right shrink-0 hidden lg:block">Ownership</span>
          <span className="w-12 shrink-0" />
        </div>

        {/* Account rows */}
        {accounts.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground text-sm">
              No investment accounts found for this client.
            </CardContent>
          </Card>
        ) : (
          <div>
            {accounts.map(account => (
              <AccountRow key={account.id} account={account} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
