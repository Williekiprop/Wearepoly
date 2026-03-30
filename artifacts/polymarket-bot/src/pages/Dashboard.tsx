import React, { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBotPolling, useBrowserOrderRelay } from "@/hooks/use-bot-data";
import { 
  TerminalCard, 
  TerminalCardHeader, 
  TerminalCardTitle, 
  TerminalCardContent, 
  ValueDisplay,
  TerminalButton,
  TerminalBadge
} from "@/components/ui/terminal";
import { 
  Activity, 
  Wallet, 
  TrendingUp, 
  Crosshair, 
  Terminal, 
  Cpu, 
  BarChart3, 
  Power, 
  Square,
  RefreshCcw,
  Bitcoin,
  LogOut
} from "lucide-react";
import { format } from "date-fns";
import { 
  ResponsiveContainer, 
  ComposedChart, 
  Line, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip,
  Cell
} from "recharts";
import { motion, AnimatePresence } from "framer-motion";

interface DashboardProps {
  onLogout?: () => void;
}

export default function Dashboard({ onLogout }: DashboardProps) {
  const { status, analysis, btc, trades, mutations } = useBotPolling();
  const queryClient = useQueryClient();
  const [startBalanceInput, setStartBalanceInput] = useState("4");
  const [mode, setMode] = useState<"test" | "live">("test");
  const [sizingMode, setSizingModeLocal] = useState<"flat" | "kelly">("flat");
  const [sniperModeLocal, setSniperModeLocal] = useState<"late" | "edge" | "both">("late");
  const [proxyInput, setProxyInput] = useState("");
  const [proxyApplied, setProxyApplied] = useState(false);
  const [localApiInput, setLocalApiInput] = useState(() =>
    localStorage.getItem("CUSTOM_API_URL") ?? ""
  );
  const [localApiSaved, setLocalApiSaved] = useState(() =>
    Boolean(localStorage.getItem("CUSTOM_API_URL"))
  );
  const [chartVisible, setChartVisible] = useState(() =>
    localStorage.getItem("CHART_VISIBLE") !== "false"
  );
  const [proxyTestResult, setProxyTestResult] = useState<{
    proxyIp: string | null;
    proxyCountry: string | null;
    proxyOrg: string | null;
    isDatacenter: boolean;
    directIp: string | null;
    proxyConfigured: boolean;
    error?: string;
  } | null>(null);

  const botData = status.data;
  const marketData = analysis.data;
  const btcData = btc.data;
  const tradesData = trades.data;

  const isRunning = botData?.running || false;
  const isLive = isRunning && botData?.mode === "live";
  const relayStatus = useBrowserOrderRelay(isLive);

  // Keep toggles in sync with the actual running state
  useEffect(() => {
    if (botData?.mode) setMode(botData.mode as "test" | "live");
  }, [botData?.mode]);

  useEffect(() => {
    if ((botData as any)?.sizingMode) setSizingModeLocal((botData as any).sizingMode);
  }, [(botData as any)?.sizingMode]);

  useEffect(() => {
    const m = (botData as any)?.sniperMode;
    if (m) setSniperModeLocal(m);
  }, [(botData as any)?.sniperMode]);

  const [thresholdInput, setThresholdInput] = useState("4");
  // Sync threshold input to actual running bot value when data arrives
  useEffect(() => {
    const live = (botData as any)?.minEdgeThreshold;
    if (live != null) setThresholdInput(String(+(live * 100).toFixed(2)));
  }, [(botData as any)?.minEdgeThreshold]);

  const handleStart = () => {
    mutations.start.mutate({
      data: {
        mode,
        startingBalance: parseFloat(startBalanceInput) || 4,
        sizingMode,
        flatSizeUsdc: 1.0,
        minEdgeThreshold: parseFloat(thresholdInput) / 100 || 0.01,
      } as any
    });
  };

  const getAuthHeader = () => {
    try {
      const token = typeof localStorage !== "undefined" ? localStorage.getItem("AUTH_TOKEN") : null;
      if (token) return { Authorization: `Bearer ${token}` };
    } catch { /* ignore */ }
    return {};
  };

  const handleThresholdUpdate = async () => {
    const val = parseFloat(thresholdInput) / 100;
    if (isNaN(val) || val <= 0 || val > 50) return;
    await fetch(`${import.meta.env.BASE_URL?.replace(/\/$/, "")}/api/bot/set-threshold`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ minEdgeThreshold: val }),
    });
    queryClient.invalidateQueries();
  };

  const handleProxyApply = () => {
    const url = proxyInput.trim() || null;
    mutations.proxy.mutate(url, {
      onSuccess: () => {
        setProxyApplied(!!url);
        setProxyTestResult(null);
        if (!url) setProxyInput("");
      }
    });
  };

  const handleProxyTest = () => {
    setProxyTestResult(null);
    mutations.proxyTest.mutate(undefined, {
      onSuccess: (data) => setProxyTestResult(data),
    });
  };

  const handleLocalApiSave = () => {
    const url = localApiInput.trim().replace(/\/+$/, "");
    if (url) {
      localStorage.setItem("CUSTOM_API_URL", url);
      setLocalApiSaved(true);
    } else {
      localStorage.removeItem("CUSTOM_API_URL");
      setLocalApiSaved(false);
    }
    window.location.reload();
  };

  const handleLocalApiClear = () => {
    localStorage.removeItem("CUSTOM_API_URL");
    setLocalApiInput("");
    setLocalApiSaved(false);
    window.location.reload();
  };

  const handleSizingToggle = (newMode: "flat" | "kelly") => {
    setSizingModeLocal(newMode);
    if (isRunning) {
      mutations.sizing.mutate({ sizingMode: newMode, flatSizeUsdc: 1.0 });
    }
  };

  const handleSniperModeChange = async (newMode: "late" | "edge" | "both") => {
    setSniperModeLocal(newMode);
    await fetch(`${import.meta.env.BASE_URL?.replace(/\/$/, "")}/api/bot/sniper-mode`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...getAuthHeader() },
      body: JSON.stringify({ sniperMode: newMode }),
    });
    queryClient.invalidateQueries();
  };

  const formatBtcPct = (val?: number | null) =>
    val != null ? `${val >= 0 ? "+" : ""}${val.toFixed(3)}%` : "---";

  const handleStop = () => {
    mutations.stop.mutate();
  };

  const handleReset = () => {
    if (confirm("Are you sure you want to reset all simulated trades and history?")) {
      mutations.reset.mutate();
    }
  };

  const formatCurrency = (val?: number | null) => 
    val != null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val) : '---';
  
  const formatPct = (val?: number | null) => 
    val != null ? `${(val * 100).toFixed(2)}%` : '---';

  const isGeoblocked = (botData as any)?.lastSignal?.includes("BLOCKED");
  const proxyEnabled = (botData as any)?.proxyEnabled === true;

  // Format data for chart — last 15 candles (15-min window)
  const chartData = (btcData?.candles?.slice(-15) ?? []).map(c => ({
    time: format(new Date(c.time), 'HH:mm'),
    close: c.close,
    volume: c.volume,
    isUp: c.close >= c.open
  }));

  return (
    <div className="min-h-screen bg-background text-foreground p-4 md:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto">
      
      {/* GEOBLOCK BANNER — shown when Polymarket blocked the live order */}
      {isGeoblocked && !proxyEnabled && (
        <div className="bg-destructive/10 border border-destructive/40 rounded-xl px-5 py-4 font-mono text-sm space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-destructive text-base">⛔</span>
            <span className="text-destructive font-bold tracking-wide">LIVE ORDERS BLOCKED — Geographic Restriction</span>
          </div>
          <p className="text-destructive/80 text-xs leading-relaxed">
            Polymarket bans all US-based server IPs. Replit runs on US servers, so every live order fails at the network layer — not a code issue.
          </p>

          <div className="border-t border-destructive/20 pt-3 space-y-2">
            <p className="text-foreground text-xs font-bold uppercase tracking-wider">Fix: Route orders through a non-US proxy</p>

            <div className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <p><span className="text-yellow-400 font-bold">Step 1 —</span> Get a EU proxy (HTTP/HTTPS or SOCKS5):</p>
              <p className="pl-3">• <span className="text-foreground">webshare.io</span> — free tier has EU proxies, upgrade for dedicated IPs</p>
              <p className="pl-3">• <span className="text-foreground">brightdata.com</span> — residential EU IPs (best geoblock bypass)</p>
              <p className="pl-3">• <span className="text-foreground">Your own VPS</span> — any EU server running Squid or Dante</p>
            </div>

            <div className="space-y-1 text-xs leading-relaxed">
              <p className="text-yellow-400 font-bold">Step 2 — Add the PROXY_URL secret to Replit:</p>
              <p className="pl-3 text-muted-foreground">In the Secrets panel (lock icon in sidebar), add:</p>
              <div className="bg-black/40 border border-border/50 rounded px-3 py-2 mt-1">
                <span className="text-green-400">Key:</span> <span className="text-foreground">PROXY_URL</span>
                <br />
                <span className="text-green-400">Value:</span> <span className="text-foreground">http://user:password@proxy-host:port</span>
              </div>
              <p className="pl-3 text-muted-foreground mt-1">SOCKS5 format: <span className="text-foreground">socks5://user:password@proxy-host:port</span></p>
            </div>

            <p className="text-xs text-muted-foreground">
              <span className="text-yellow-400 font-bold">Step 3 —</span> Restart the API server workflow. The proxy indicator in the header will turn <span className="text-green-400">green</span>.
            </p>
          </div>

          <p className="text-muted-foreground text-xs border-t border-destructive/20 pt-2">
            TEST mode works perfectly without a proxy — full paper trading with real Polymarket prices.
          </p>
        </div>
      )}

      {/* PROXY ACTIVE CONFIRMATION */}
      {proxyEnabled && (
        <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-5 py-3 font-mono text-sm">
          <span className="text-green-400 text-base">🛡</span>
          <div className="flex flex-col gap-0.5">
            <span className="text-green-400 font-bold tracking-wide">PROXY ACTIVE — Geoblock Bypassed</span>
            <span className="text-muted-foreground text-xs">All Polymarket requests are routing through your configured proxy. LIVE mode orders should reach the CLOB API.</span>
          </div>
        </div>
      )}

      {/* BROWSER-RELAY STATUS — shown when LIVE mode active (no proxy needed) */}
      {isLive && !proxyEnabled && relayStatus.state === "idle" && (
        <div className="flex items-center gap-3 bg-blue-500/10 border border-blue-500/30 rounded-xl px-5 py-3 font-mono text-sm">
          <span className="text-blue-400 text-base">⚡</span>
          <div className="flex flex-col gap-0.5">
            <span className="text-blue-400 font-bold tracking-wide">BROWSER-RELAY ACTIVE — Keep this tab open</span>
            <span className="text-muted-foreground text-xs">Orders are signed on the server and submitted through your browser (VPN machine). Dashboard must stay open while trading.</span>
          </div>
        </div>
      )}
      {isLive && relayStatus.state === "submitting" && (
        <div className="flex items-center gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-5 py-3 font-mono text-sm animate-pulse">
          <span className="text-yellow-400 text-base">⏳</span>
          <div className="flex flex-col gap-0.5">
            <span className="text-yellow-400 font-bold tracking-wide">SUBMITTING ORDER VIA BROWSER...</span>
            <span className="text-muted-foreground text-xs">
              BUY {relayStatus.meta.direction} — ${relayStatus.meta.sizeUsdc.toFixed(2)} @ {(relayStatus.meta.price * 100).toFixed(1)}¢ — routing via your VPN
            </span>
          </div>
        </div>
      )}
      {isLive && relayStatus.state === "success" && (
        <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-5 py-3 font-mono text-sm">
          <span className="text-green-400 text-base">✓</span>
          <div className="flex flex-col gap-0.5">
            <span className="text-green-400 font-bold tracking-wide">ORDER PLACED — {relayStatus.orderId}</span>
            <span className="text-muted-foreground text-xs">Successfully submitted via browser relay through your VPN.</span>
          </div>
        </div>
      )}
      {isLive && relayStatus.state === "error" && (
        <div className="flex items-center gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-5 py-3 font-mono text-sm">
          <span className="text-red-400 text-base">✗</span>
          <div className="flex flex-col gap-0.5">
            <span className="text-red-400 font-bold tracking-wide">ORDER FAILED</span>
            <span className="text-muted-foreground text-xs">{relayStatus.message}</span>
          </div>
        </div>
      )}

      {/* DRAWDOWN PROTECTION BANNER */}
      {isRunning && (() => {
        const d = botData as any;
        const paused = d?.drawdownPaused;
        const streak = d?.lossStreak ?? 0;
        const sizingMul = d?.sizingMultiplier ?? 1.0;
        const dailyLoss = (d?.dailyLossPct ?? 0) * 100;
        const weeklyLoss = (d?.weeklyLossPct ?? 0) * 100;
        const LOSS_STREAK_HALF = 5;
        const isHalved = streak >= LOSS_STREAK_HALF && !paused;

        if (!paused && !isHalved && streak < 3) return null;

        return (
          <div className={`border rounded-xl px-5 py-4 font-mono text-sm space-y-3 ${
            paused
              ? "bg-destructive/10 border-destructive/40"
              : "bg-yellow-500/8 border-yellow-500/30"
          }`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={paused ? "text-destructive text-base" : "text-yellow-400 text-base"}>
                  {paused ? "⛔" : "⚠️"}
                </span>
                <span className={`font-bold tracking-wide ${paused ? "text-destructive" : "text-yellow-400"}`}>
                  {paused
                    ? d?.weeklyStopTriggered ? "WEEKLY STOP HIT — Trading Paused"
                      : d?.dailyStopTriggered  ? "DAILY STOP HIT — Trading Paused"
                      : `LOSS STREAK STOP (${streak} losses) — Trading Paused`
                    : `RISK WARNING — ${streak} consecutive losses (sizing ×${sizingMul.toFixed(1)})`}
                </span>
              </div>
              {paused && (
                <button
                  onClick={() => mutations.resetStops.mutate()}
                  disabled={mutations.resetStops.isPending}
                  className="px-3 py-1.5 rounded-lg bg-green-500/20 border border-green-500/40 text-green-400 text-xs font-bold hover:bg-green-500/30 transition-colors disabled:opacity-50"
                >
                  {mutations.resetStops.isPending ? "Resuming..." : "▶ Continue Trading"}
                </button>
              )}
            </div>
            <div className="flex gap-6 text-xs text-muted-foreground">
              <span>Loss streak: <span className={streak >= 7 ? "text-destructive font-bold" : streak >= 5 ? "text-yellow-400" : "text-foreground"}>{streak}</span></span>
              <span>Daily loss: <span className={dailyLoss >= 40 ? "text-destructive font-bold" : dailyLoss >= 20 ? "text-yellow-400" : "text-foreground"}>{dailyLoss.toFixed(1)}%</span> of {dailyLoss > 0 ? `$${(d?.dailyStartBalance ?? 0).toFixed(2)}` : "—"}</span>
              <span>Weekly loss: <span className={weeklyLoss >= 60 ? "text-destructive font-bold" : weeklyLoss >= 30 ? "text-yellow-400" : "text-foreground"}>{weeklyLoss.toFixed(1)}%</span> of {weeklyLoss > 0 ? `$${(d?.weeklyStartBalance ?? 0).toFixed(2)}` : "—"}</span>
              <span>Sizing: <span className={sizingMul < 1 ? "text-yellow-400 font-bold" : "text-foreground"}>×{sizingMul.toFixed(1)}</span></span>
            </div>
            {!paused && (
              <p className="text-xs text-muted-foreground">Position size halved. Trading will pause after {7 - streak} more consecutive loss{7 - streak === 1 ? "" : "es"}.</p>
            )}
          </div>
        );
      })()}

      {/* HEADER */}
      <header className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/30 flex items-center justify-center">
            <Terminal className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold font-mono tracking-tight text-foreground flex items-center gap-2">
              POLYMARKET_BTC <span className="text-primary text-glow-success">EDGE_ENGINE</span>
            </h1>
            <div className="flex items-center gap-2 mt-1">
              <span className="flex h-2 w-2 relative">
                <span className={cn("animate-ping absolute inline-flex h-full w-full rounded-full opacity-75", isRunning ? "bg-primary" : "bg-muted-foreground")}></span>
                <span className={cn("relative inline-flex rounded-full h-2 w-2", isRunning ? "bg-primary" : "bg-muted-foreground")}></span>
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                {isRunning ? "SYSTEM_ACTIVE" : "SYSTEM_STANDBY"} • v1.0.5
              </span>
              {proxyEnabled && (
                <span className="text-[10px] font-mono bg-green-500/15 text-green-400 border border-green-500/30 rounded px-1.5 py-0.5 tracking-wide">PROXY ON</span>
              )}
              {(() => {
                const ws = (botData as any)?.btcWs;
                if (!ws) return null;
                return (
                  <span className={cn(
                    "text-[10px] font-mono border rounded px-1.5 py-0.5 tracking-wide",
                    ws.connected
                      ? "bg-cyan-500/15 text-cyan-400 border-cyan-500/30"
                      : "bg-muted/20 text-muted-foreground border-border"
                  )}>
                    {ws.connected ? "WS●" : "WS○"}
                  </span>
                );
              })()}
            </div>
          </div>
        </div>

        {/* Global BTC Ticker + Logout */}
        <div className="flex items-center gap-2">
        <div className="flex items-center gap-4 bg-card border border-border/50 rounded-xl px-4 py-2 shadow-lg">
          <Bitcoin className="w-5 h-5 text-warning" />
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">BTC/USD (Global)</span>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-mono font-bold">{formatCurrency(btcData?.currentPrice)}</span>
              <span className={cn("text-xs font-mono font-medium", 
                ((btcData as any)?.change1m || 0) >= 0 ? "text-success" : "text-destructive"
              )}>
                {formatBtcPct((btcData as any)?.change1m)} (1m)
              </span>
              <span className={cn("text-[10px] font-mono", 
                (btcData?.change5m || 0) >= 0 ? "text-success/60" : "text-destructive/60"
              )}>
                {formatBtcPct(btcData?.change5m)} (5m)
              </span>
            </div>
          </div>
        </div>
        {onLogout && (
          <button
            onClick={onLogout}
            title="Sign out"
            className="flex items-center gap-1.5 px-3 h-9 rounded-lg border border-border/50 bg-card text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors font-mono text-xs"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">SIGN OUT</span>
          </button>
        )}
        </div>
      </header>

      {/* TOP KPI ROW */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <TerminalCard>
          <TerminalCardContent className="flex items-center justify-between p-5">
            <ValueDisplay 
              label="Current Balance" 
              value={formatCurrency(botData?.balance)} 
              subValue={`Start: ${formatCurrency(botData?.startingBalance)}`}
              highlight="primary"
            />
            <div className="flex flex-col items-end gap-2">
              <div className="p-3 bg-primary/10 rounded-full text-primary">
                <Wallet className="w-5 h-5" />
              </div>
              {botData?.mode === 'live' && (
                <button
                  onClick={async () => {
                    await fetch(`${import.meta.env.BASE_URL?.replace(/\/$/, "")}/api/bot/sync-balance`, { method: "POST", headers: getAuthHeader() });
                    queryClient.invalidateQueries();
                  }}
                  className="text-[9px] font-mono text-primary/70 hover:text-primary border border-primary/20 hover:border-primary/50 rounded px-1.5 py-0.5 transition-colors"
                  title="Fetch live wallet balance from Polygon"
                >
                  ↻ sync
                </button>
              )}
            </div>
          </TerminalCardContent>
        </TerminalCard>

        <TerminalCard>
          <TerminalCardContent className="flex items-center justify-between p-5">
            <ValueDisplay 
              label="Total P&L" 
              value={formatCurrency(botData?.totalPnl)} 
              highlight={(botData?.totalPnl || 0) >= 0 ? "success" : "danger"}
            />
            <div className={cn("p-3 rounded-full", (botData?.totalPnl || 0) >= 0 ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>
              <Activity className="w-5 h-5" />
            </div>
          </TerminalCardContent>
        </TerminalCard>

        <TerminalCard>
          <TerminalCardContent className="flex items-center justify-between p-5">
            <ValueDisplay 
              label="Win Rate" 
              value={formatPct(botData?.winRate)} 
              subValue={`${botData?.winningTrades ?? 0}W / ${botData?.losingTrades ?? 0}L`}
              highlight={(botData?.winRate || 0) > 0.5 ? "success" : "warning"}
            />
            <div className="p-3 bg-warning/10 rounded-full text-warning">
              <TrendingUp className="w-5 h-5" />
            </div>
          </TerminalCardContent>
        </TerminalCard>

        <TerminalCard>
          <TerminalCardContent className="flex items-center justify-between p-5">
            <ValueDisplay 
              label="Total Trades" 
              value={botData?.totalTrades || 0} 
              subValue={botData?.mode === 'test' ? 'SIMULATED' : 'LIVE'}
            />
            <div className="p-3 bg-secondary rounded-full text-muted-foreground">
              <Crosshair className="w-5 h-5" />
            </div>
          </TerminalCardContent>
        </TerminalCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* LEFT COL: Bot Control & Signal Panel */}
        <div className="space-y-6">
          <TerminalCard>
            <TerminalCardHeader>
              <TerminalCardTitle><Cpu className="w-4 h-4"/> Engine Control</TerminalCardTitle>
            </TerminalCardHeader>
            <TerminalCardContent className="space-y-6 p-6">
              
              <div className="flex flex-col gap-3">
                {/* Mode Toggle */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block mb-2">Trading Mode</label>
                  <div className={cn(
                    "relative flex rounded-lg p-1 gap-1 transition-colors",
                    isRunning ? "opacity-50 pointer-events-none" : "",
                    "bg-secondary/40 border border-border/50"
                  )}>
                    <button
                      onClick={() => setMode("test")}
                      className={cn(
                        "flex-1 py-2 px-3 rounded-md text-xs font-bold font-mono tracking-wide transition-all duration-200",
                        mode === "test"
                          ? "bg-warning/20 text-warning border border-warning/40 shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      📊 TEST
                    </button>
                    <button
                      onClick={() => setMode("live")}
                      className={cn(
                        "flex-1 py-2 px-3 rounded-md text-xs font-bold font-mono tracking-wide transition-all duration-200",
                        mode === "live"
                          ? "bg-destructive/20 text-destructive border border-destructive/40 shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      ⚡ LIVE
                    </button>
                  </div>
                  {mode === "live" ? (
                    proxyEnabled ? (
                      <div className="mt-2 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2 text-[10px] font-mono text-green-400 leading-relaxed">
                        <span className="font-bold">🛡 EU proxy active</span> — geoblock bypassed. Orders route through proxy.
                      </div>
                    ) : (botData as any)?.geoblockCooldownSec > 0 ? (
                      <div className="mt-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2 text-[10px] font-mono text-yellow-400 leading-relaxed space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-bold">⏱ Proxy geoblocked — cooldown {Math.ceil((botData as any).geoblockCooldownSec / 60)}m left</span>
                          <button
                            onClick={async () => {
                              await fetch(`${import.meta.env.BASE_URL?.replace(/\/$/, "")}/api/bot/proxy/retry`, { method: "POST", headers: getAuthHeader() });
                              queryClient.invalidateQueries();
                            }}
                            className="ml-2 shrink-0 px-2 py-0.5 rounded bg-yellow-500/20 border border-yellow-500/40 hover:bg-yellow-500/30 text-yellow-300 font-bold text-[9px] transition-colors"
                          >
                            ↻ RETRY NOW
                          </button>
                        </div>
                        <div>Switched VPN/proxy to EU? Hit Retry Now to skip the cooldown.</div>
                      </div>
                    ) : (
                    <div className="mt-2 bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-[10px] font-mono text-destructive/90 leading-relaxed space-y-1">
                      <div className="font-bold">⛔ No EU proxy set</div>
                      <div>Paste your London proxy URL in the field below, then click APPLY to enable live orders.</div>
                    </div>
                    )
                  ) : (
                    <p className="text-[10px] font-mono mt-1.5 text-warning leading-relaxed">
                      Paper trades on real Polymarket prices. P&amp;L reflects actual BTC momentum.
                    </p>
                  )}
                </div>

                {/* Balance Input */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block mb-2">
                    {mode === "live" ? "Starting Balance (USDC)" : "Paper Balance ($)"}
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono">$</span>
                    <input 
                      type="number" 
                      value={startBalanceInput}
                      onChange={(e) => setStartBalanceInput(e.target.value)}
                      disabled={isRunning}
                      className="w-full bg-input border border-border rounded-md h-10 pl-7 pr-3 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary disabled:opacity-50"
                    />
                  </div>
                </div>

                {/* Edge Threshold Input */}
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block mb-2">
                    Min Edge Threshold (%)
                  </label>
                  <div className="flex gap-1.5 items-center">
                    <div className="relative flex-1">
                      <input
                        type="number"
                        min="0.1"
                        max="50"
                        step="0.1"
                        value={thresholdInput}
                        onChange={(e) => setThresholdInput(e.target.value)}
                        className="w-full bg-input border border-border rounded-md h-10 pl-3 pr-7 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono text-xs">%</span>
                    </div>
                    {isRunning && (
                      <button
                        onClick={handleThresholdUpdate}
                        className="shrink-0 h-10 px-3 rounded-md text-xs font-bold font-mono tracking-wide border bg-primary/10 text-primary border-primary/40 hover:bg-primary/20 transition-colors"
                        title="Update threshold on the running bot"
                      >
                        SET
                      </button>
                    )}
                  </div>
                  <p className="text-[9px] font-mono text-muted-foreground/60 mt-1">
                    Bot trades only when model edge ≥ this. Data shows 19–21% is the sweet spot (75–90% win rate). Above 22% the model is chasing extreme prices — those are capped automatically.
                    {botData && (
                      <span className="text-primary/60"> Current: {(((botData as any).minEdgeThreshold ?? 0.01) * 100).toFixed(1)}%</span>
                    )}
                  </p>
                </div>
              </div>

              {/* Proxy URL Input */}
              <div className="space-y-2">
                <label className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider flex items-center gap-1.5">
                  EU Proxy URL
                  {proxyEnabled && <span className="text-green-400 font-mono text-[9px] bg-green-500/15 border border-green-500/30 px-1.5 py-0.5 rounded">ACTIVE</span>}
                </label>

                {/* Current proxy display when active and not re-entering */}
                {proxyEnabled && (botData as any)?.proxyDisplay && !proxyApplied && (
                  <div className="text-[10px] font-mono text-green-400 bg-green-500/10 border border-green-500/25 rounded px-3 py-1.5 truncate">
                    {(botData as any).proxyDisplay}
                  </div>
                )}

                {/* Input row */}
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={proxyInput}
                    onChange={(e) => { setProxyInput(e.target.value); setProxyApplied(false); setProxyTestResult(null); }}
                    placeholder="http://user:pass@host:port"
                    className="flex-1 min-w-0 bg-input border border-border rounded-md h-9 px-3 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary placeholder:text-muted-foreground/40"
                  />
                  <button
                    onClick={handleProxyApply}
                    disabled={mutations.proxy.isPending}
                    className={cn(
                      "shrink-0 h-9 px-3 rounded-md text-xs font-bold font-mono tracking-wide border transition-colors",
                      proxyApplied
                        ? "bg-green-500/20 text-green-400 border-green-500/40"
                        : "bg-primary/10 text-primary border-primary/40 hover:bg-primary/20"
                    )}
                  >
                    {mutations.proxy.isPending ? "…" : proxyApplied ? "✓ ON" : "APPLY"}
                  </button>
                  {proxyEnabled && (
                    <button
                      onClick={() => { setProxyInput(""); setProxyTestResult(null); mutations.proxy.mutate(null, { onSuccess: () => setProxyApplied(false) }); }}
                      className="shrink-0 h-9 px-2 rounded-md text-xs font-mono text-destructive border border-destructive/30 hover:bg-destructive/10 transition-colors"
                      title="Clear proxy"
                    >✕</button>
                  )}
                </div>

                {/* Test Proxy button — only when proxy is active */}
                {proxyEnabled && (
                  <button
                    onClick={handleProxyTest}
                    disabled={mutations.proxyTest.isPending}
                    className="w-full h-8 rounded-md text-[10px] font-bold font-mono tracking-wide border border-border/60 bg-secondary/40 text-muted-foreground hover:text-foreground hover:border-border transition-colors"
                  >
                    {mutations.proxyTest.isPending ? "TESTING EXIT IP…" : "TEST PROXY — CHECK EXIT IP"}
                  </button>
                )}

                {/* Test result */}
                {proxyTestResult && (
                  <div className={cn(
                    "rounded-lg px-3 py-2.5 font-mono text-[10px] space-y-1.5 border",
                    proxyTestResult.error
                      ? "bg-destructive/10 border-destructive/30"
                      : proxyTestResult.isDatacenter
                        ? "bg-yellow-500/10 border-yellow-500/30"
                        : proxyTestResult.proxyIp !== proxyTestResult.directIp
                          ? "bg-green-500/10 border-green-500/30"
                          : "bg-yellow-500/10 border-yellow-500/30"
                  )}>
                    {proxyTestResult.error ? (
                      <>
                        <div className="font-bold text-destructive">⛔ Proxy connection failed</div>
                        <div className="text-destructive/80 break-all">{proxyTestResult.error}</div>
                        <div className="text-muted-foreground">Check the URL format and that the proxy server is online.</div>
                      </>
                    ) : (
                      <>
                        <div className={cn("font-bold",
                          proxyTestResult.proxyIp === proxyTestResult.directIp ? "text-yellow-400"
                          : proxyTestResult.isDatacenter ? "text-yellow-400"
                          : "text-green-400"
                        )}>
                          {proxyTestResult.proxyIp === proxyTestResult.directIp
                            ? "⚠ Same IP — proxy not routing"
                            : proxyTestResult.isDatacenter
                              ? "⚠ Datacenter IP — Polymarket may block"
                              : "✓ Residential IP — should bypass geoblock"}
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Exit IP:</span>
                          <span className="text-foreground">{proxyTestResult.proxyIp ?? "unknown"}</span>
                        </div>
                        {proxyTestResult.proxyCountry && (
                          <div className="flex justify-between gap-2">
                            <span className="text-muted-foreground">Location:</span>
                            <span className={cn("font-bold",
                              proxyTestResult.proxyCountry.toLowerCase().includes("united states") ? "text-destructive" : "text-green-400"
                            )}>
                              {proxyTestResult.proxyCountry}
                            </span>
                          </div>
                        )}
                        {proxyTestResult.proxyOrg && (
                          <div className="flex justify-between gap-2">
                            <span className="text-muted-foreground">ISP / Org:</span>
                            <span className={cn("text-right break-all", proxyTestResult.isDatacenter ? "text-yellow-400" : "text-green-400")}>
                              {proxyTestResult.proxyOrg}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between gap-2">
                          <span className="text-muted-foreground">Replit IP:</span>
                          <span className="text-muted-foreground">{proxyTestResult.directIp ?? "unknown"}</span>
                        </div>
                        {proxyTestResult.isDatacenter && (
                          <div className="text-yellow-300/90 pt-0.5 border-t border-yellow-500/20 leading-relaxed">
                            Datacenter/proxy IPs are on Polymarket's blocklist. You need a <span className="font-bold text-yellow-300">residential UK proxy</span> — try Bright Data or Smartproxy (UK residential plan).
                          </div>
                        )}
                        {proxyTestResult.proxyCountry?.toLowerCase().includes("united states") && (
                          <div className="text-destructive pt-0.5 border-t border-destructive/20">
                            US exit IP — still geoblocked. Switch to a UK/EU proxy.
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                  {proxyEnabled
                    ? "Click TEST to verify the exit IP is outside the US."
                    : "Paste your London/EU proxy URL. HTTP and SOCKS5 both work."}
                </p>
              </div>

              {/* Local API Server Override */}
              <div className="space-y-2">
                <label className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider flex items-center gap-1.5">
                  Local API Server
                  {localApiSaved && (
                    <span className="text-green-400 font-mono text-[9px] bg-green-500/15 border border-green-500/30 px-1.5 py-0.5 rounded">
                      ACTIVE
                    </span>
                  )}
                </label>

                {localApiSaved && (
                  <div className="text-[10px] font-mono text-green-400 bg-green-500/10 border border-green-500/25 rounded px-3 py-1.5 truncate">
                    {localStorage.getItem("CUSTOM_API_URL")}
                  </div>
                )}

                <div className="flex gap-1.5">
                  <input
                    type="text"
                    placeholder="https://xxxx.ngrok-free.app"
                    value={localApiInput}
                    onChange={(e) => { setLocalApiInput(e.target.value); setLocalApiSaved(false); }}
                    className="flex-1 bg-input border border-border rounded-md h-9 px-3 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary placeholder:text-muted-foreground/40"
                  />
                  <TerminalButton
                    onClick={handleLocalApiSave}
                    className="h-9 px-3 text-[11px] font-mono whitespace-nowrap"
                  >
                    {localApiSaved ? "✓ SAVED" : "SAVE"}
                  </TerminalButton>
                  {localApiSaved && (
                    <TerminalButton
                      onClick={handleLocalApiClear}
                      variant="danger"
                      className="h-9 px-3 text-[11px] font-mono"
                    >
                      CLEAR
                    </TerminalButton>
                  )}
                </div>

                <div className="bg-secondary/30 border border-border/50 rounded-lg px-3 py-2 space-y-1">
                  <p className="text-[10px] font-mono text-yellow-400 font-bold">Bypass geoblock without any proxy</p>
                  <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                    Run the API server on your own machine with Proton VPN, then expose it with:
                  </p>
                  <code className="block text-[10px] font-mono text-primary/90 bg-background/50 rounded px-2 py-1 mt-1">
                    ngrok http 8080
                  </code>
                  <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                    Paste the <span className="text-foreground">https://xxxx.ngrok-free.app</span> URL above. All bot API calls will route through your VPN machine.
                  </p>
                </div>
              </div>

              {/* Sizing Toggle */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block mb-2">Trade Sizing</label>
                <div className={cn(
                  "relative flex rounded-lg p-1 gap-1 bg-secondary/40 border border-border/50 transition-colors"
                )}>
                  <button
                    onClick={() => handleSizingToggle("flat")}
                    className={cn(
                      "flex-1 py-2 px-3 rounded-md text-xs font-bold font-mono tracking-wide transition-all duration-200",
                      sizingMode === "flat"
                        ? "bg-primary/20 text-primary border border-primary/40 shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    FLAT $1
                  </button>
                  <button
                    onClick={() => handleSizingToggle("kelly")}
                    className={cn(
                      "flex-1 py-2 px-3 rounded-md text-xs font-bold font-mono tracking-wide transition-all duration-200",
                      sizingMode === "kelly"
                        ? "bg-primary/20 text-primary border border-primary/40 shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    KELLY
                  </button>
                </div>
                <p className="text-[10px] font-mono mt-1.5 text-muted-foreground leading-relaxed">
                  {sizingMode === "flat"
                    ? "Fixed $1.00 per trade — safe for testing live orders."
                    : "Quarter-Kelly formula scales size to edge &amp; balance."}
                </p>
              </div>

              {/* ── Sniper Mode ─────────────────────────────────────────── */}
              <div>
                <label className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider block mb-2">Sniper Mode</label>
                <div className="relative flex rounded-lg p-1 gap-1 bg-secondary/40 border border-border/50">
                  {(["late", "edge", "both"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => handleSniperModeChange(m)}
                      className={cn(
                        "flex-1 py-2 px-2 rounded-md text-xs font-bold font-mono tracking-wide transition-all duration-200",
                        sniperModeLocal === m
                          ? "bg-primary/20 text-primary border border-primary/40 shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {m.toUpperCase()}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] font-mono mt-1.5 text-muted-foreground leading-relaxed">
                  {sniperModeLocal === "late"
                    ? "Enter final 5–40 s only · hold to resolution · TP at 15¢."
                    : sniperModeLocal === "edge"
                    ? "Enter after 1st minute · TP at 8¢ · re-enter on next edge."
                    : "Edge snipes mid-window + late snipe in final 40 s."}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <TerminalButton 
                  onClick={handleStart} 
                  disabled={mutations.start.isPending}
                  className="w-full relative overflow-hidden group"
                >
                  <span className="relative z-10 flex items-center gap-2"><Power className="w-4 h-4"/> START BOT</span>
                  {!isRunning && <div className="absolute inset-0 bg-primary/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />}
                </TerminalButton>
                
                <TerminalButton 
                  onClick={handleStop} 
                  disabled={!isRunning || mutations.stop.isPending}
                  variant="danger"
                  className="w-full"
                >
                  <Square className="w-4 h-4 mr-2"/> STOP
                </TerminalButton>
              </div>

              <TerminalButton 
                onClick={handleReset} 
                disabled={isRunning || mutations.reset.isPending}
                variant="ghost"
                size="sm"
                className="w-full text-[10px]"
              >
                <RefreshCcw className="w-3 h-3 mr-2"/> PURGE HISTORY & RESET
              </TerminalButton>
            </TerminalCardContent>
          </TerminalCard>

          <TerminalCard className={cn("transition-all duration-500", isRunning ? "border-primary/50 box-glow-primary" : "")}>
            <TerminalCardHeader>
              <TerminalCardTitle><Activity className="w-4 h-4"/> Live Signal — 5m Window</TerminalCardTitle>
              {isRunning && <span className="flex h-2 w-2 relative"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span></span>}
            </TerminalCardHeader>
            <TerminalCardContent className="p-4 flex flex-col items-center justify-center text-center space-y-3">
              
              {/* UP / DOWN prices + countdown */}
              <div className="w-full grid grid-cols-3 gap-2">
                <div className={cn("p-3 rounded-lg border-2 text-center transition-all", 
                  marketData?.signal === 'BUY_YES' ? "border-success bg-success/10" : "border-border/40 bg-secondary/20")}>
                  <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">↑ UP</div>
                  <div className={cn("text-xl font-mono font-bold", marketData?.signal === 'BUY_YES' ? "text-success" : "text-foreground")}>
                    {((marketData as any)?.upPrice != null ? ((marketData as any).upPrice * 100).toFixed(1) : "—")}¢
                  </div>
                </div>
                <div className="p-3 rounded-lg border border-border/30 bg-secondary/10 text-center">
                  <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">Window</div>
                  <div className={cn("text-lg font-mono font-bold tabular-nums", 
                    ((marketData as any)?.secondsRemaining ?? 300) < 60 ? "text-yellow-500" : "text-foreground")}>
                    {(marketData as any)?.secondsRemaining != null 
                      ? `${Math.floor(((marketData as any).secondsRemaining) / 60)}:${String(((marketData as any).secondsRemaining) % 60).padStart(2, '0')}`
                      : "—:——"}
                  </div>
                </div>
                <div className={cn("p-3 rounded-lg border-2 text-center transition-all",
                  marketData?.signal === 'BUY_NO' ? "border-destructive bg-destructive/10" : "border-border/40 bg-secondary/20")}>
                  <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">↓ DOWN</div>
                  <div className={cn("text-xl font-mono font-bold", marketData?.signal === 'BUY_NO' ? "text-destructive" : "text-foreground")}>
                    {((marketData as any)?.downPrice != null ? ((marketData as any).downPrice * 100).toFixed(1) : "—")}¢
                  </div>
                </div>
              </div>

              <AnimatePresence mode="wait">
                <motion.div 
                  key={marketData?.signal || 'NONE'}
                  initial={{ scale: 0.95, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.95, opacity: 0 }}
                  className={cn(
                    "px-4 py-4 rounded-xl border-2 w-full",
                    marketData?.signal === 'BUY_YES' ? "bg-success/10 border-success text-success" :
                    marketData?.signal === 'BUY_NO' ? "bg-destructive/10 border-destructive text-destructive" :
                    "bg-secondary/50 border-border text-muted-foreground"
                  )}
                >
                  <div className="text-[9px] font-bold tracking-widest uppercase mb-1 opacity-70">Bot Signal</div>
                  <div className="text-2xl font-black tracking-tight font-mono">
                    {marketData?.signal === 'BUY_YES' ? '↑ BUY UP' :
                     marketData?.signal === 'BUY_NO'  ? '↓ BUY DOWN' : 'NO TRADE'}
                  </div>
                  <div className="text-[10px] mt-1 opacity-60">
                    {marketData?.signal === 'NO_TRADE'
                      ? `Model: ${formatPct(marketData?.estimatedTrueProb)} UP · Edge: ${formatPct(Math.abs(marketData?.edge ?? 0))} (need ${formatPct((marketData as any)?.minEdgeThreshold ?? 0.03)})`
                      : `Edge: ${formatPct(Math.abs(marketData?.edge ?? 0))} · Model: ${formatPct(marketData?.estimatedTrueProb)} UP · Resolves at window end`}
                  </div>
                </motion.div>
              </AnimatePresence>

              <div className="grid grid-cols-2 gap-2 w-full">
                <div className="p-2 bg-secondary/30 rounded-lg border border-border/50 text-left">
                  <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">Model P(UP)</div>
                  <div className="text-base font-mono text-foreground">{formatPct(marketData?.estimatedTrueProb)}</div>
                  <div className="text-[9px] text-muted-foreground">market: {((marketData as any)?.upPrice != null ? formatPct((marketData as any).upPrice) : '—')}</div>
                </div>
                <div className="p-2 bg-secondary/30 rounded-lg border border-border/50 text-left">
                  <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">Edge</div>
                  <div className={cn("text-base font-mono", Math.abs(marketData?.edge ?? 0) >= 0.03 ? "text-success" : "text-muted-foreground")}>
                    {(marketData?.edge ?? 0) >= 0 ? "+" : ""}{formatPct(marketData?.edge)}
                  </div>
                  <div className="text-[9px] text-muted-foreground">threshold: {formatPct((marketData as any)?.minEdgeThreshold ?? 0.03)}</div>
                </div>
              </div>
            </TerminalCardContent>
          </TerminalCard>
        </div>

        {/* MIDDLE COL: Strategy Metrics */}
        <div className="space-y-6">
          <TerminalCard>
            <TerminalCardHeader>
              <TerminalCardTitle><BarChart3 className="w-4 h-4"/> 5-Minute Market Window</TerminalCardTitle>
            </TerminalCardHeader>
            <TerminalCardContent className="space-y-4">
              {/* Market title */}
              <div className="bg-secondary/20 p-3 rounded border border-border/30">
                <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">Active Market</div>
                <div className="text-xs font-mono text-foreground/80 leading-snug">
                  {marketData?.marketTitle ?? "Loading..."}
                </div>
              </div>

              {/* Big UP / DOWN price bars */}
              <div className="grid grid-cols-2 gap-3">
                <div className={cn("p-4 rounded-xl border-2 text-center", 
                  (marketData as any)?.upPrice > 0.5 ? "border-success/60 bg-success/5" : "border-border/30 bg-secondary/10")}>
                  <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">↑ BTC UP</div>
                  <div className={cn("text-3xl font-mono font-black",
                    (marketData as any)?.upPrice > 0.5 ? "text-success" : "text-foreground")}>
                    {(marketData as any)?.upPrice != null ? `${((marketData as any).upPrice * 100).toFixed(1)}¢` : "—"}
                  </div>
                  <div className="text-[9px] text-muted-foreground mt-1">implied prob</div>
                </div>
                <div className={cn("p-4 rounded-xl border-2 text-center",
                  (marketData as any)?.downPrice > 0.5 ? "border-destructive/60 bg-destructive/5" : "border-border/30 bg-secondary/10")}>
                  <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">↓ BTC DOWN</div>
                  <div className={cn("text-3xl font-mono font-black",
                    (marketData as any)?.downPrice > 0.5 ? "text-destructive" : "text-foreground")}>
                    {(marketData as any)?.downPrice != null ? `${((marketData as any).downPrice * 100).toFixed(1)}¢` : "—"}
                  </div>
                  <div className="text-[9px] text-muted-foreground mt-1">implied prob</div>
                </div>
              </div>

              {/* Our model vs market */}
              <div className="flex items-center justify-between p-3 border border-border/40 rounded-lg bg-secondary/10">
                <div>
                  <div className="text-[9px] text-muted-foreground uppercase font-bold">Our Model P(UP)</div>
                  <div className="text-xs text-muted-foreground mt-0.5">momentum + mean-reversion</div>
                </div>
                <div className="text-xl font-mono font-bold text-primary">
                  {formatPct(marketData?.estimatedTrueProb)}
                </div>
              </div>
            </TerminalCardContent>
          </TerminalCard>

          <TerminalCard>
            <TerminalCardHeader>
              <TerminalCardTitle><Crosshair className="w-4 h-4"/> Sizing & Impact</TerminalCardTitle>
            </TerminalCardHeader>
            <TerminalCardContent className="space-y-4">
              
              <div className="flex items-center justify-between p-3 border border-border/50 rounded-lg bg-secondary/10">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase font-bold">Expected Value (EV/Share)</div>
                  <div className="text-sm font-mono mt-1 text-muted-foreground">EV = p*(1-c) - (1-p)*c</div>
                </div>
                <div className={cn("text-2xl font-mono font-bold", (marketData?.evPerShare || 0) > 0 ? "text-success" : "text-foreground")}>
                  {formatCurrency(marketData?.evPerShare)}
                </div>
              </div>

              <div className="flex items-center justify-between p-3 border border-border/50 rounded-lg bg-secondary/10">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase font-bold">Kelly Sizing (25%)</div>
                  <div className="text-sm font-mono mt-1 text-muted-foreground">f* = (p*b - q) / b</div>
                </div>
                <div className="text-2xl font-mono font-bold text-primary">
                  {formatCurrency(marketData?.kellySize)}
                </div>
              </div>

              <div className="flex items-center justify-between p-3 border border-border/50 rounded-lg bg-secondary/10">
                <div>
                  <div className="text-[10px] text-muted-foreground uppercase font-bold">Est. Price Impact</div>
                  <div className="text-sm font-mono mt-1 text-muted-foreground">Slippage guard</div>
                </div>
                <div className={cn("text-2xl font-mono font-bold", (marketData?.priceImpact || 0) > 0.02 ? "text-warning" : "text-foreground")}>
                  {formatPct(marketData?.priceImpact)}
                </div>
              </div>

            </TerminalCardContent>
          </TerminalCard>
        </div>

        {/* RIGHT COL: BTC Chart */}
        <div className="space-y-6">
          <TerminalCard className="flex flex-col">
            <TerminalCardHeader>
              <TerminalCardTitle><TrendingUp className="w-4 h-4"/> BTC 15M Price Action</TerminalCardTitle>
              <button
                onClick={() => {
                  const next = !chartVisible;
                  setChartVisible(next);
                  localStorage.setItem("CHART_VISIBLE", String(next));
                }}
                className="ml-auto text-[10px] font-mono text-muted-foreground hover:text-foreground border border-border/50 hover:border-border rounded px-2 py-0.5 transition-colors"
              >
                {chartVisible ? "HIDE" : "SHOW"}
              </button>
            </TerminalCardHeader>
            <TerminalCardContent className={cn("p-2", !chartVisible && "hidden")}>
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis 
                      dataKey="time" 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={10} 
                      tickLine={false}
                      axisLine={false}
                      minTickGap={20}
                    />
                    <YAxis 
                      yAxisId="price"
                      domain={['auto', 'auto']} 
                      stroke="hsl(var(--muted-foreground))" 
                      fontSize={10}
                      tickFormatter={(val) => `$${val.toLocaleString()}`}
                      tickLine={false}
                      axisLine={false}
                    />
                    <RechartsTooltip 
                      contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '8px' }}
                      itemStyle={{ color: 'hsl(var(--foreground))', fontFamily: 'monospace' }}
                      labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}
                      formatter={(value: number) => [`$${value.toLocaleString()}`, 'Price']}
                    />
                    <Line 
                      yAxisId="price"
                      type="monotone" 
                      dataKey="close" 
                      stroke="hsl(var(--primary))" 
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: 'hsl(var(--primary))' }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm font-mono">
                  WAITING FOR DATA STREAM...
                </div>
              )}
            </TerminalCardContent>
          </TerminalCard>
        </div>

      </div>

      {/* BOTTOM: Trade Log */}
      <TerminalCard>
        <TerminalCardHeader>
          <TerminalCardTitle><Terminal className="w-4 h-4"/> Execution Log</TerminalCardTitle>
          <span className="text-xs font-mono text-muted-foreground border border-border px-2 py-1 rounded bg-secondary/50">
            Total Records: {tradesData?.total || 0}
          </span>
        </TerminalCardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse font-mono">
            <thead className="text-[10px] uppercase bg-secondary/30 text-muted-foreground border-b border-border/50">
              <tr>
                <th className="px-4 py-3 font-semibold">Time</th>
                <th className="px-4 py-3 font-semibold">Dir</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold text-right">Entry Prob</th>
                <th className="px-4 py-3 font-semibold text-right">Edge</th>
                <th className="px-4 py-3 font-semibold text-right">Size</th>
                <th className="px-4 py-3 font-semibold text-right">Impact</th>
                <th className="px-4 py-3 font-semibold text-right">P&L</th>
              </tr>
            </thead>
            <tbody>
              {tradesData?.trades && tradesData.trades.length > 0 ? (
                tradesData.trades.map((trade) => (
                  <tr key={trade.id} className="border-b border-border/30 hover:bg-secondary/20 transition-colors">
                    <td className="px-4 py-3 text-muted-foreground">
                      {format(new Date(trade.timestamp), 'HH:mm:ss')}
                    </td>
                    <td className="px-4 py-3">
                      <TerminalBadge variant={trade.direction === 'YES' ? 'success' : 'danger'}>
                        {trade.direction}
                      </TerminalBadge>
                    </td>
                    <td className="px-4 py-3 flex gap-1 items-center">
                      <TerminalBadge variant={trade.status === 'open' ? 'warning' : 'default'} className="bg-transparent">
                        {trade.status}
                      </TerminalBadge>
                      {(trade as { mode?: string }).mode === 'live' && (
                        <TerminalBadge variant="danger" className="text-[9px] px-1">LIVE</TerminalBadge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">{formatCurrency(trade.marketPrice)}</td>
                    <td className="px-4 py-3 text-right text-success">{formatPct(trade.edge)}</td>
                    <td className="px-4 py-3 text-right">{formatCurrency(trade.positionSize)}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{formatPct(trade.priceImpact)}</td>
                    <td className={cn("px-4 py-3 text-right font-bold", 
                      trade.pnl && trade.pnl > 0 ? "text-success" : 
                      trade.pnl && trade.pnl < 0 ? "text-destructive" : 
                      "text-muted-foreground"
                    )}>
                      {trade.status === 'open'
                        ? <span className="text-warning font-mono text-xs animate-pulse">HOLDING...</span>
                        : formatCurrency(trade.pnl)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground font-mono text-sm border-b border-border/30 bg-secondary/5">
                    NO EXECUTIONS LOGGED
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </TerminalCard>

    </div>
  );
}

// Utility class merge for component file
function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(" ");
}
