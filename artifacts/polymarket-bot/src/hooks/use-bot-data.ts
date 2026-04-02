import { useQueryClient, useMutation, keepPreviousData } from "@tanstack/react-query";
import { useEffect, useRef, useState, useCallback } from "react";
import { 
  useGetBotStatus, 
  useGetMarketAnalysis, 
  useGetBtcPrice,
  useGetTrades,
  useStartBot,
  useStopBot,
  useResetBot,
  getGetBotStatusQueryKey,
  getGetTradesQueryKey
} from "@workspace/api-client-react";

const API_BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") + "/api";

function authHeaders(): Record<string, string> {
  try {
    const token = typeof localStorage !== "undefined" ? localStorage.getItem("AUTH_TOKEN") : null;
    if (token) return { Authorization: `Bearer ${token}` };
  } catch { /* ignore */ }
  return {};
}

/**
 * Returns a fetch wrapper that automatically adds auth headers and
 * resolves the path relative to the API base URL.
 * Usage: const f = useAuthFetch(); await f("/api/backtest?windows=100");
 */
export function useAuthFetch() {
  return useCallback((path: string, init?: RequestInit) => {
    const url = path.startsWith("http") ? path : `${API_BASE}${path.replace(/^\/api/, "")}`;
    return fetch(url, { ...init, headers: { ...authHeaders(), ...(init?.headers ?? {}) } });
  }, []);
}

// ──────────────────────────────────────────────────────────────────────────────
// Browser-relay hook: polls server for pending LIVE orders, submits them
// directly from the browser (which is on the user's VPN-connected machine).
// Private key never leaves the server — only the pre-signed payload is sent.
// ──────────────────────────────────────────────────────────────────────────────
export type RelayStatus =
  | { state: "idle" }
  | { state: "submitting"; meta: { direction: string; price: number; sizeUsdc: number } }
  | { state: "success"; orderId: string }
  | { state: "error"; message: string };

export function useBrowserOrderRelay(isLive: boolean) {
  const [relayStatus, setRelayStatus] = useState<RelayStatus>({ state: "idle" });
  const submitting = useRef(false);
  const queryClient = useQueryClient();

  const pollAndSubmit = useCallback(async () => {
    if (submitting.current) return;

    // Check for pending order
    const res = await fetch(`${API_BASE}/bot/pending-order`, { headers: authHeaders() }).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json() as { pending: null | {
      id: string; url: string; method: string; headers: Record<string, string>;
      body: string; meta: { direction: string; price: number; sizeUsdc: number };
      context: Record<string, unknown>;
    }};
    if (!data.pending) return;

    submitting.current = true;
    setRelayStatus({ state: "submitting", meta: data.pending.meta });

    let orderId: string | undefined;
    let success = false;
    let errorMessage: string | undefined;
    let actualShares: number | undefined; // actual tokens received from CLOB fill
    let clobStatus: string | undefined;   // "matched" = on-chain settled, "live" = still in order book

    // Helper: parse the Polymarket response from either path
    const parsePoly = (status: number, text: string) => {
      let json: { orderID?: string; error?: string; errorMsg?: string; takingAmount?: string; makingAmount?: string; status?: string } = {};
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      return { status, text, json };
    };

    try {
      // ── PATH 1: Browser → Polymarket DIRECTLY (uses user's VPN/NL IP) ──────
      // This bypasses Polymarket's geoblock on the Replit server IP.
      // If CORS blocks it (Replit workspace iframe), we catch the TypeError and fall back.
      let polyText: string | null = null;
      let polyStatus = 0;
      let usedDirectPath = false;

      try {
        console.log("[RELAY] Trying direct browser → Polymarket:", data.pending.url);
        const directRes = await fetch(data.pending.url, {
          method: data.pending.method,
          headers: { "Content-Type": "application/json", ...data.pending.headers },
          body: data.pending.body,
        });
        polyText = await directRes.text();
        polyStatus = directRes.status;
        usedDirectPath = true;
        console.log("[RELAY] Direct response:", polyStatus, polyText.slice(0, 300));
      } catch (corsErr) {
        // CORS or network error — browser can't reach Polymarket directly from this context.
        // Fall through to server relay.
        console.warn("[RELAY] Direct fetch blocked (CORS/CSP), falling back to server relay:", corsErr instanceof Error ? corsErr.message : corsErr);
      }

      // ── PATH 2: Browser → Server → Polymarket (server-side proxy/direct) ──
      if (!usedDirectPath || polyText === null) {
        console.log("[RELAY] Using server relay to:", data.pending.url);
        const relayRes = await fetch(`${API_BASE}/bot/relay-submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({
            url: data.pending.url,
            method: data.pending.method,
            headers: data.pending.headers,
            body: data.pending.body,
          }),
        });
        polyText = await relayRes.text();
        polyStatus = relayRes.status;
        console.log("[RELAY] Server relay response:", polyStatus, polyText.slice(0, 300));
      }

      const { json: polyJson } = parsePoly(polyStatus, polyText ?? "");
      if (polyStatus >= 200 && polyStatus < 300 && polyJson.orderID) {
        orderId = polyJson.orderID;
        success = true;
        if (polyJson.takingAmount) actualShares = parseFloat(polyJson.takingAmount);
        clobStatus = polyJson.status;
        setRelayStatus({ state: "success", orderId });
        setTimeout(() => setRelayStatus({ state: "idle" }), 4000);
      } else {
        errorMessage = `HTTP ${polyStatus}: ${polyJson.error ?? polyJson.errorMsg ?? polyText}`;
        console.error("[RELAY] Order failed:", errorMessage);
        setRelayStatus({ state: "error", message: errorMessage });
        setTimeout(() => setRelayStatus({ state: "idle" }), 6000);
      }
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      console.error("[RELAY] Exception:", errorMessage);
      setRelayStatus({ state: "error", message: errorMessage });
      setTimeout(() => setRelayStatus({ state: "idle" }), 6000);
    }

    // Report result back to server (include actual fill amounts and CLOB status)
    await fetch(`${API_BASE}/bot/complete-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ orderId, success, errorMessage, context: data.pending.context, actualShares, clobStatus }),
    }).catch(() => null);

    queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
    submitting.current = false;
  }, [queryClient]);

  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(pollAndSubmit, 3000);
    return () => clearInterval(interval);
  }, [isLive, pollAndSubmit]);

  return relayStatus;
}

// Wrap generated hooks to add polling logic
export function useBotPolling() {
  const queryClient = useQueryClient();

  // 1. Poll bot status every 3 seconds always to know if it's running
  // keepPreviousData: never clear the UI to undefined while a refetch is in
  // flight — prevents the dot from flashing grey on every poll cycle.
  const statusQuery = useGetBotStatus({
    query: {
      refetchInterval: 3000,
      staleTime: 2000,
      placeholderData: keepPreviousData,
    }
  });

  const isRunning = statusQuery.data?.running === true;

  // 2. Poll market analysis every 5s only if running, otherwise every 15s to keep UI alive
  const analysisQuery = useGetMarketAnalysis({
    query: {
      refetchInterval: isRunning ? 5000 : 15000,
      staleTime: 4000,
      placeholderData: keepPreviousData,
    }
  });

  // 3. Poll BTC price every 10s regardless
  const btcQuery = useGetBtcPrice({
    query: {
      refetchInterval: 10000,
      staleTime: 9000,
      placeholderData: keepPreviousData,
    }
  });

  // 4. Poll trades — fast (2s) when there are open live positions awaiting resolution, else 5s
  const tradesQuery = useGetTrades(
    { limit: 50, offset: 0 }, 
    {
      query: {
        refetchInterval: (query) => {
          if (!isRunning) return false;
          const data = query.state.data as { trades?: Array<{ status: string; mode?: string }> } | undefined;
          const hasOpenLive = data?.trades?.some(t => t.status === 'open' && t.mode === 'live') ?? false;
          return hasOpenLive ? 2000 : 5000;
        },
      }
    }
  );

  // Mutations
  const startMutation = useStartBot({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
      }
    }
  });

  const stopMutation = useStopBot({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      }
    }
  });

  const resetMutation = useResetBot({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
      }
    }
  });

  const proxyTestMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/bot/proxy/test`, { headers: authHeaders() });
      if (!res.ok) throw new Error("Proxy test failed");
      return res.json() as Promise<{
        proxyIp: string | null;
        proxyCountry: string | null;
        proxyOrg: string | null;
        isDatacenter: boolean;
        directIp: string | null;
        proxyConfigured: boolean;
        error?: string;
      }>;
    },
  });

  const proxyMutation = useMutation({
    mutationFn: async (proxyUrl: string | null) => {
      const res = await fetch(`${API_BASE}/bot/proxy`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ proxyUrl }),
      });
      if (!res.ok) throw new Error("Proxy update failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
    },
  });

  const sizingMutation = useMutation({
    mutationFn: async (payload: { sizingMode: "flat" | "kelly"; flatSizeUsdc?: number }) => {
      const res = await fetch(`${API_BASE}/bot/sizing`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Sizing update failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
    },
  });

  const resetStopsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/bot/reset-stops`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      if (!res.ok) throw new Error("Reset stops failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
    },
  });

  const cancelPositionMutation = useMutation({
    mutationFn: async (tradeId: number) => {
      const res = await fetch(`${API_BASE}/bot/cancel-position/${tradeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancel failed");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
    },
  });

  return {
    status: statusQuery,
    analysis: analysisQuery,
    btc: btcQuery,
    trades: tradesQuery,
    mutations: {
      start: startMutation,
      stop: stopMutation,
      reset: resetMutation,
      sizing: sizingMutation,
      proxy: proxyMutation,
      proxyTest: proxyTestMutation,
      resetStops: resetStopsMutation,
      cancelPosition: cancelPositionMutation,
    }
  };
}
