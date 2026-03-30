import { useState, useCallback } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/Dashboard";
import Login from "@/pages/Login";

function makeQueryClient(onUnauthorized: () => void) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          // Don't retry 401s — just log out
          const status = (error as { status?: number })?.status;
          if (status === 401) { onUnauthorized(); return false; }
          return failureCount < 1;
        },
      },
    },
  });
}

function useAuth() {
  const [token, setToken] = useState<string | null>(() =>
    typeof localStorage !== "undefined" ? localStorage.getItem("AUTH_TOKEN") : null
  );

  const login = useCallback((newToken: string) => {
    localStorage.setItem("AUTH_TOKEN", newToken);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("AUTH_TOKEN");
    setToken(null);
  }, []);

  return { token, login, logout };
}

function App() {
  const { token, login, logout } = useAuth();

  // Re-create the QueryClient when logout changes so stale auth queries are cleared
  const [queryClient] = useState(() => makeQueryClient(logout));

  if (!token) {
    return <Login onLogin={login} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter
          base={import.meta.env.BASE_URL ? import.meta.env.BASE_URL.replace(/\/$/, "") : "/"}
        >
          <Switch>
            <Route path="/" component={() => <Dashboard onLogout={logout} />} />
            <Route component={NotFound} />
          </Switch>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
