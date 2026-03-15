import { useQueryClient, useMutation } from "@tanstack/react-query";
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
    const res = await fetch(`${API_BASE}/bot/pending-order`).catch(() => null);
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

    try {
      // POST directly to Polymarket from this browser (VPN-connected machine)
      const polyRes = await fetch(data.pending.url, {
        method: "POST",
        headers: data.pending.headers,
        body: data.pending.body,
      });
      const polyText = await polyRes.text();
      let polyJson: { orderID?: string; error?: string; errorMsg?: string } = {};
      try { polyJson = JSON.parse(polyText); } catch { /* non-JSON */ }

      if (polyRes.ok && polyJson.orderID) {
        orderId = polyJson.orderID;
        success = true;
        setRelayStatus({ state: "success", orderId });
        setTimeout(() => setRelayStatus({ state: "idle" }), 4000);
      } else {
        errorMessage = polyJson.error ?? polyJson.errorMsg ?? polyText ?? `HTTP ${polyRes.status}`;
        setRelayStatus({ state: "error", message: errorMessage ?? "Unknown error" });
        setTimeout(() => setRelayStatus({ state: "idle" }), 6000);
      }
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
      setRelayStatus({ state: "error", message: errorMessage });
      setTimeout(() => setRelayStatus({ state: "idle" }), 6000);
    }

    // Report result back to server
    await fetch(`${API_BASE}/bot/complete-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, success, errorMessage, context: data.pending.context }),
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
  const statusQuery = useGetBotStatus({
    query: {
      refetchInterval: 3000,
      staleTime: 2000,
    }
  });

  const isRunning = statusQuery.data?.running === true;

  // 2. Poll market analysis every 5s only if running, otherwise every 15s to keep UI alive
  const analysisQuery = useGetMarketAnalysis({
    query: {
      refetchInterval: isRunning ? 5000 : 15000,
      staleTime: 4000,
    }
  });

  // 3. Poll BTC price every 10s regardless
  const btcQuery = useGetBtcPrice({
    query: {
      refetchInterval: 10000,
      staleTime: 9000,
    }
  });

  // 4. Poll trades occasionally, or invalidate on actions
  const tradesQuery = useGetTrades(
    { limit: 50, offset: 0 }, 
    {
      query: {
        refetchInterval: isRunning ? 5000 : false,
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
      const res = await fetch(`${API_BASE}/bot/proxy/test`);
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Sizing update failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getGetBotStatusQueryKey() });
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
    }
  };
}
