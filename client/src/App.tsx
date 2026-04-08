import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import Dashboard from "@/pages/Dashboard";
import ClientPortfolio from "@/pages/ClientPortfolio";
import NotFound from "@/pages/not-found";

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="dark">
        <Router hook={useHashLocation}>
          <Switch>
            <Route path="/" component={Dashboard} />
            <Route path="/client/:id" component={ClientPortfolio} />
            <Route component={NotFound} />
          </Switch>
        </Router>
        <Toaster />
      </div>
    </QueryClientProvider>
  );
}
