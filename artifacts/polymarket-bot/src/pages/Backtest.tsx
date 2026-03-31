import React, { useState, useCallback } from "react";
import {
  TerminalCard,
  TerminalCardHeader,
  TerminalCardTitle,
  TerminalCardContent,
  TerminalButton,
} from "@/components/ui/terminal";
import {
  FlaskConical,
  TrendingUp,
  BarChart3,
  Clock,
  ArrowLeft,
  RefreshCcw,
  CheckCircle,
  XCircle,
  Info,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Cell,
  ReferenceLine,
  ComposedChart,
  Line,
} from "recharts";
import { cn } from "@/lib/utils";
import { useAuthFetch } from "@/hooks/use-bot-data";

// ── Types matching the API response ──────────────────────────────────────────

interface BacktestTrade {
  windowStart:    number;
  windowEnd:      number;
  entryTimeUtc:   string;
  direction:      "YES" | "NO";
  entryPrice:     number;
  modelProb:      number;
  signalStrength: number;
  change1m:       number;
  change5m:       number;
  change1h:       number;
  inWindowDelta:  number;
  btcWindowMove:  number;
  resolvedUp:     boolean;
  won:            boolean;
  pnl:            number;
  pnlPct:         number;
}

interface BacktestStats {
  totalTrades:       number;
  wins:              number;
  losses:            number;
  winRate:           number;
  avgSignalStrength: number;
  totalPnlAt50c:     number;
  roiAt50c:          number;
  profitFactor:      number;
  yesTrades:         { count: number; wins: number; winRate: number };
  noTrades:          { count: number; wins: number; winRate: number };
  byHour:            Record<string, { trades: number; wins: number; winRate: number }>;
  bySignal:          Array<{ label: string; count: number; wins: number; winRate: number; avgPnl: number }>;
}

interface BacktestResult {
  trades:          BacktestTrade[];
  stats:           BacktestStats;
  windowsScanned:  number;
  windowsResolved: number;
  windowsSkipped:  number;
  durationMs:      number;
  entryPriceNote:  string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt    = (n: number, d = 1) => n.toFixed(d);
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`;
const fmtPnl = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}¢`;
const fmtTs  = (ts: number) => {
  const d = new Date(ts * 1000);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }) + " UTC";
};

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  onBack: () => void;
}

export default function Backtest({ onBack }: Props) {
  const authFetch = useAuthFetch();
  const [windows, setWindows]     = useState(100);
  const [loading, setLoading]     = useState(false);
  const [result, setResult]       = useState<BacktestResult | null>(null);
  const [error, setError]         = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "signal" | "trades" | "hours">("overview");

  const runBacktest = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/backtest?windows=${windows}`);
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Server error ${res.status}: ${txt}`);
      }
      const data = await res.json() as BacktestResult;
      setResult(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [authFetch, windows]);

  const stats  = result?.stats;
  const trades = result?.trades ?? [];

  // Cumulative PnL chart data (oldest → newest)
  const cumPnlData = trades.slice().reverse().map((t, i, arr) => {
    const cumPnl = arr.slice(0, i + 1).reduce((s, x) => s + x.pnl, 0);
    return { idx: i + 1, cumPnl, won: t.won };
  });

  // Hour chart data
  const hourData = stats
    ? Array.from({ length: 24 }, (_, h) => {
        const hd = stats.byHour[String(h)];
        return { hour: `${String(h).padStart(2, "0")}`, trades: hd?.trades ?? 0, winRate: hd ? hd.winRate * 100 : null };
      }).filter(h => h.trades > 0)
    : [];

  return (
    <div className="min-h-screen bg-background text-foreground font-mono p-4">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors p-1">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="flex items-center gap-2 flex-wrap">
          <FlaskConical className="w-5 h-5 text-primary" />
          <span className="text-lg font-bold tracking-tight">Strategy Backtest</span>
          <span className="text-[10px] text-muted-foreground px-2 py-0.5 bg-secondary/40 rounded border border-border/40">
            BTC UP/DOWN 5m · Polymarket + Binance data
          </span>
        </div>
      </div>

      {/* Controls */}
      <TerminalCard className="mb-6">
        <TerminalCardContent className="p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground uppercase font-bold">Windows</span>
              <div className="flex items-center gap-1">
                {[50, 100, 150, 200].map(n => (
                  <button
                    key={n}
                    onClick={() => setWindows(n)}
                    className={cn(
                      "px-2 py-1 text-[10px] font-mono rounded border transition-all",
                      windows === n
                        ? "bg-primary/20 border-primary text-primary"
                        : "border-border/40 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <span className="text-[9px] text-muted-foreground">
                ≈ {Math.round(windows * 5 / 60)}h history
              </span>
            </div>
            <TerminalButton
              onClick={runBacktest}
              disabled={loading}
              className="flex items-center gap-2"
            >
              {loading
                ? <><RefreshCcw className="w-3 h-3 animate-spin" /> Scanning…</>
                : <><FlaskConical className="w-3 h-3" /> Run Backtest</>}
            </TerminalButton>
            {loading && (
              <span className="text-[10px] text-muted-foreground animate-pulse">
                Fetching {windows} Polymarket windows + Binance candles…
              </span>
            )}
          </div>
        </TerminalCardContent>
      </TerminalCard>

      {error && (
        <div className="mb-6 p-3 bg-destructive/10 border border-destructive/40 rounded-lg text-destructive text-xs font-mono">
          {error}
        </div>
      )}

      {result && stats && (
        <>
          {/* Scan summary row */}
          <div className="mb-4 text-[10px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
            <span>Scanned: <b className="text-foreground">{result.windowsScanned}</b> windows</span>
            <span>Resolved: <b className="text-foreground">{result.windowsResolved}</b></span>
            <span>Signals: <b className="text-foreground">{stats.totalTrades}</b></span>
            <span>Duration: <b className="text-foreground">{(result.durationMs / 1000).toFixed(1)}s</b></span>
          </div>

          {/* KPI strip */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <KPI label="Signals fired"   value={String(stats.totalTrades)} />
            <KPI label="Win Rate"        value={fmtPct(stats.winRate)}
              color={stats.winRate >= 0.55 ? "success" : stats.winRate >= 0.50 ? "warn" : "danger"} />
            <KPI label="ROI @ 50¢"       value={`${stats.roiAt50c >= 0 ? "+" : ""}${fmt(stats.roiAt50c, 1)}¢`}
              color={stats.roiAt50c >= 0 ? "success" : "danger"} />
            <KPI label="Profit Factor"   value={isFinite(stats.profitFactor) ? fmt(stats.profitFactor, 2) : "∞"}
              color={stats.profitFactor >= 1.2 ? "success" : stats.profitFactor >= 1 ? "warn" : "danger"} />
            <KPI label="Avg Signal"      value={fmtPct(stats.avgSignalStrength)} />
            <KPI label="W / L"           value={`${stats.wins} / ${stats.losses}`} />
          </div>

          {/* Entry price disclaimer */}
          <div className="mb-4 p-3 border border-yellow-500/30 bg-yellow-500/5 rounded-lg flex gap-2">
            <Info className="w-3 h-3 text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="text-[9px] text-yellow-200/70 leading-relaxed">{result.entryPriceNote}</div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 mb-4 flex-wrap">
            {([["overview", "Overview"], ["signal", "Signal Strength"], ["trades", `Trade Log (${trades.length})`], ["hours", "By Hour"]] as const).map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  "px-3 py-1.5 text-[10px] font-bold uppercase rounded border transition-all",
                  activeTab === tab
                    ? "bg-primary/20 border-primary text-primary"
                    : "border-border/40 text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* ── OVERVIEW ── */}
          {activeTab === "overview" && (
            <div className="space-y-6">
              {/* Cumulative PnL chart */}
              <TerminalCard>
                <TerminalCardHeader>
                  <TerminalCardTitle><TrendingUp className="w-4 h-4"/> Cumulative PnL at 50¢ entry (¢ per $1 staked)</TerminalCardTitle>
                </TerminalCardHeader>
                <TerminalCardContent className="p-4">
                  {cumPnlData.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <ComposedChart data={cumPnlData} margin={{ left: 10, right: 10, top: 5, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="idx" tick={{ fontSize: 9, fill: "#666" }}
                          label={{ value: "Signal #", position: "insideBottom", offset: -3, fontSize: 9, fill: "#666" }} />
                        <YAxis tick={{ fontSize: 9, fill: "#666" }} tickFormatter={v => `${v.toFixed(0)}¢`} />
                        <RechartsTooltip
                          contentStyle={{ background: "#0a0a0a", border: "1px solid #333", fontSize: 10 }}
                          formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v.toFixed(1)}¢`, "Cum PnL"]}
                        />
                        <ReferenceLine y={0} stroke="#555" strokeDasharray="4 2" />
                        <Line type="monotone" dataKey="cumPnl"
                          stroke={stats.totalPnlAt50c >= 0 ? "#22c55e" : "#ef4444"}
                          strokeWidth={2} dot={false} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-40 flex items-center justify-center text-muted-foreground text-xs">
                      No signals in this window
                    </div>
                  )}
                </TerminalCardContent>
              </TerminalCard>

              {/* YES vs NO breakdown */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <TerminalCard>
                  <TerminalCardHeader>
                    <TerminalCardTitle><BarChart3 className="w-4 h-4"/> Direction Breakdown</TerminalCardTitle>
                  </TerminalCardHeader>
                  <TerminalCardContent className="p-4 space-y-3">
                    <SideBreakdown label="↑ YES (predicted UP)" data={stats.yesTrades} color="success" />
                    <SideBreakdown label="↓ NO (predicted DOWN)" data={stats.noTrades} color="destructive" />
                    <div className="pt-2 border-t border-border/30">
                      <div className="text-[9px] text-muted-foreground leading-relaxed">
                        A 50% win rate at 50¢ entry = break-even (no edge, no loss). Above 50% means 
                        the model's direction is better than a coin flip. Live entry prices below 50¢ 
                        mean lower break-even win rate requirement and higher real returns.
                      </div>
                    </div>
                  </TerminalCardContent>
                </TerminalCard>

                {/* Quick hour winners */}
                <TerminalCard>
                  <TerminalCardHeader>
                    <TerminalCardTitle><Clock className="w-4 h-4"/> Best Hours (UTC)</TerminalCardTitle>
                  </TerminalCardHeader>
                  <TerminalCardContent className="p-4">
                    {hourData.length > 0 ? (
                      <div className="grid grid-cols-4 gap-2">
                        {[...hourData].sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0)).slice(0, 8).map(h => (
                          <div key={h.hour} className="p-2 bg-secondary/20 rounded border border-border/30 text-center">
                            <div className="text-[9px] text-muted-foreground">{h.hour}:00</div>
                            <div className={cn("text-sm font-bold font-mono",
                              (h.winRate ?? 0) >= 60 ? "text-success" : (h.winRate ?? 0) >= 50 ? "text-yellow-400" : "text-destructive")}>
                              {(h.winRate ?? 0).toFixed(0)}%
                            </div>
                            <div className="text-[9px] text-muted-foreground">{h.trades}✓</div>
                          </div>
                        ))}
                      </div>
                    ) : <div className="text-xs text-muted-foreground">No hour data</div>}
                  </TerminalCardContent>
                </TerminalCard>
              </div>
            </div>
          )}

          {/* ── SIGNAL STRENGTH ── */}
          {activeTab === "signal" && (
            <div className="space-y-6">
              <TerminalCard>
                <TerminalCardHeader>
                  <TerminalCardTitle><BarChart3 className="w-4 h-4"/> Win Rate by Signal Strength (|model − 50%|)</TerminalCardTitle>
                </TerminalCardHeader>
                <TerminalCardContent className="p-4">
                  {stats.bySignal.length > 0 ? (
                    <>
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={stats.bySignal.map(s => ({ ...s, winRatePct: s.winRate * 100 }))} margin={{ left: 10, right: 10, top: 10, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#666" }} />
                          <YAxis tick={{ fontSize: 9, fill: "#666" }} domain={[0, 100]} tickFormatter={v => `${v}%`} />
                          <RechartsTooltip
                            contentStyle={{ background: "#0a0a0a", border: "1px solid #333", fontSize: 10 }}
                            formatter={(v: number, name: string) => [
                              name === "winRatePct" ? `${v?.toFixed(1)}%` : v,
                              name === "winRatePct" ? "Win Rate" : "Trades",
                            ]}
                          />
                          <ReferenceLine y={50} stroke="#555" strokeDasharray="4 2"
                            label={{ value: "50% (break-even)", fill: "#777", fontSize: 8, position: "insideTopLeft" }} />
                          <Bar dataKey="winRatePct" radius={[3, 3, 0, 0]}>
                            {stats.bySignal.map((s, i) => (
                              <Cell key={i} fill={s.winRate >= 0.6 ? "#22c55e" : s.winRate >= 0.5 ? "#eab308" : "#ef4444"} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>

                      <div className="mt-4 space-y-2">
                        {stats.bySignal.map(s => (
                          <div key={s.label} className="grid grid-cols-5 gap-2 text-[10px] items-center">
                            <span className="text-muted-foreground font-mono">{s.label}</span>
                            <span className="text-right">{s.count} signals</span>
                            <span className="text-right">{s.wins}W / {s.count - s.wins}L</span>
                            <span className={cn("text-right font-bold",
                              s.winRate >= 0.60 ? "text-success" : s.winRate >= 0.50 ? "text-yellow-400" : "text-destructive")}>
                              {fmtPct(s.winRate)}
                            </span>
                            <span className={cn("text-right", s.avgPnl >= 0 ? "text-success/70" : "text-destructive/70")}>
                              {fmtPnl(s.avgPnl)}/trade
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="h-40 flex items-center justify-center text-muted-foreground text-xs">No signal data</div>
                  )}
                </TerminalCardContent>
              </TerminalCard>

              <TerminalCard>
                <TerminalCardContent className="p-4">
                  <div className="text-[9px] text-muted-foreground space-y-1 leading-relaxed">
                    <div className="font-bold text-foreground/60 uppercase mb-2">Backtest Methodology</div>
                    <div>• Each resolved BTC 5m market fetched from Polymarket Gamma API via its slug (<code>btc-updown-5m-{"{timestamp}"}</code>)</div>
                    <div>• BTC signals reconstructed from Binance 1m candles: change1m/5m/1h + in-window delta (BTC move since window open)</div>
                    <div>• Model applied identically to live: <code>probUp = 0.5 + change1m×0.40 + change5m×0.05 + change1h×0.02 + inWindowDelta×2.00</code></div>
                    <div>• OBI, liquidation bias, funding rate = 0 (not available historically) — live results on Render will have higher edge</div>
                    <div>• Signal fires when <code>|probUp − 0.5| ≥ 5%</code></div>
                    <div>• Entry price assumed = <b>50¢</b> (max lag). Real prices often 30–50¢ for the favoured side → live win requirement lower</div>
                    <div>• Outcome determined by Gamma API resolution (not our BTC close estimate)</div>
                    <div>• PnL assumes $1 staked at 50¢ entry: win = +50¢, loss = −50¢</div>
                  </div>
                </TerminalCardContent>
              </TerminalCard>
            </div>
          )}

          {/* ── TRADES ── */}
          {activeTab === "trades" && (
            <TerminalCard>
              <TerminalCardHeader>
                <TerminalCardTitle><FlaskConical className="w-4 h-4"/> Signal Log (newest first)</TerminalCardTitle>
              </TerminalCardHeader>
              <TerminalCardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-[10px] font-mono">
                    <thead>
                      <tr className="border-b border-border/40 text-muted-foreground">
                        <th className="px-3 py-2 text-left">Window (UTC)</th>
                        <th className="px-3 py-2 text-left">Dir</th>
                        <th className="px-3 py-2 text-right">Signal</th>
                        <th className="px-3 py-2 text-right">Model</th>
                        <th className="px-3 py-2 text-right">Δ1m</th>
                        <th className="px-3 py-2 text-right">ΔWin</th>
                        <th className="px-3 py-2 text-right">BTC 5m</th>
                        <th className="px-3 py-2 text-center">Result</th>
                        <th className="px-3 py-2 text-right">PnL@50¢</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trades.map((t, i) => (
                        <tr key={i} className={cn("border-b border-border/20 hover:bg-secondary/10 transition-colors", i % 2 === 0 ? "" : "bg-secondary/5")}>
                          <td className="px-3 py-1.5 text-muted-foreground">{fmtTs(t.windowStart)}</td>
                          <td className="px-3 py-1.5">
                            <span className={cn("font-bold", t.direction === "YES" ? "text-success" : "text-destructive")}>
                              {t.direction === "YES" ? "↑ YES" : "↓ NO"}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right text-primary">
                            {(t.signalStrength * 100).toFixed(1)}%
                          </td>
                          <td className="px-3 py-1.5 text-right">{(t.modelProb * 100).toFixed(1)}%</td>
                          <td className={cn("px-3 py-1.5 text-right", t.change1m >= 0 ? "text-success/70" : "text-destructive/70")}>
                            {t.change1m >= 0 ? "+" : ""}{t.change1m.toFixed(3)}%
                          </td>
                          <td className={cn("px-3 py-1.5 text-right", t.inWindowDelta >= 0 ? "text-success/70" : "text-destructive/70")}>
                            {t.inWindowDelta >= 0 ? "+" : ""}{(t.inWindowDelta * 100).toFixed(3)}%
                          </td>
                          <td className={cn("px-3 py-1.5 text-right", t.btcWindowMove >= 0 ? "text-success/60" : "text-destructive/60")}>
                            {t.btcWindowMove >= 0 ? "+" : ""}{t.btcWindowMove.toFixed(3)}%
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            {t.won
                              ? <CheckCircle className="w-3 h-3 text-success inline" />
                              : <XCircle    className="w-3 h-3 text-destructive inline" />}
                          </td>
                          <td className={cn("px-3 py-1.5 text-right font-bold", t.pnl >= 0 ? "text-success" : "text-destructive")}>
                            {fmtPnl(t.pnl)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {trades.length === 0 && (
                    <div className="py-12 text-center text-muted-foreground text-xs">
                      No signals fired — all windows had neutral model output (&lt;5% from 50/50).
                    </div>
                  )}
                </div>
              </TerminalCardContent>
            </TerminalCard>
          )}

          {/* ── HOURS ── */}
          {activeTab === "hours" && (
            <TerminalCard>
              <TerminalCardHeader>
                <TerminalCardTitle><Clock className="w-4 h-4"/> Win Rate by Hour (UTC)</TerminalCardTitle>
              </TerminalCardHeader>
              <TerminalCardContent className="p-4">
                {hourData.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={hourData} margin={{ left: 10, right: 10, top: 10, bottom: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="hour" tick={{ fontSize: 8, fill: "#666" }}
                          label={{ value: "Hour UTC", position: "insideBottom", offset: -10, fontSize: 9, fill: "#666" }} />
                        <YAxis tick={{ fontSize: 9, fill: "#666" }} domain={[0, 100]} tickFormatter={v => `${v}%`} />
                        <RechartsTooltip
                          contentStyle={{ background: "#0a0a0a", border: "1px solid #333", fontSize: 10 }}
                          formatter={(v: number, name: string) => [
                            name === "winRate" ? `${v?.toFixed(1)}%` : v,
                            name === "winRate" ? "Win Rate" : "Signals",
                          ]}
                        />
                        <ReferenceLine y={50} stroke="#555" strokeDasharray="4 2" />
                        <Bar dataKey="winRate" radius={[3, 3, 0, 0]}>
                          {hourData.map((h, i) => (
                            <Cell key={i} fill={(h.winRate ?? 0) >= 60 ? "#22c55e" : (h.winRate ?? 0) >= 50 ? "#eab308" : "#ef4444"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    <div className="mt-3 text-[9px] text-muted-foreground">
                      Best hours are when BTC momentum is consistent within each 5-minute window. 
                      High win rate hours = Polymarket consistently lags BTC repricing in those hours.
                    </div>
                  </>
                ) : (
                  <div className="h-40 flex items-center justify-center text-muted-foreground text-xs">No hourly data</div>
                )}
              </TerminalCardContent>
            </TerminalCard>
          )}
        </>
      )}

      {!result && !loading && (
        <div className="flex flex-col items-center justify-center py-24 text-center text-muted-foreground space-y-3">
          <FlaskConical className="w-10 h-10 opacity-20" />
          <div className="text-sm font-mono">Select a window count and run the backtest</div>
          <div className="text-[10px] max-w-md leading-relaxed">
            Fetches real resolved Polymarket BTC 5m markets + Binance price history.
            Reconstructs the model's signals and checks directional accuracy.
            Takes ~5–15 seconds for 100 windows.
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function KPI({ label, value, color }: { label: string; value: string; color?: "success" | "danger" | "warn" }) {
  return (
    <TerminalCard>
      <TerminalCardContent className="p-3">
        <div className="text-[9px] text-muted-foreground uppercase font-bold mb-1">{label}</div>
        <div className={cn(
          "text-lg font-black font-mono",
          color === "success" ? "text-success"
            : color === "danger" ? "text-destructive"
            : color === "warn" ? "text-yellow-400"
            : "text-foreground"
        )}>
          {value}
        </div>
      </TerminalCardContent>
    </TerminalCard>
  );
}

function SideBreakdown({
  label,
  data,
  color,
}: {
  label:  string;
  data:   { count: number; wins: number; winRate: number };
  color:  "success" | "destructive";
}) {
  if (data.count === 0) {
    return (
      <div className="p-3 rounded-lg border border-border/30 bg-secondary/10">
        <div className={cn("text-[10px] font-bold mb-1", color === "success" ? "text-success" : "text-destructive")}>{label}</div>
        <div className="text-[10px] text-muted-foreground">No signals</div>
      </div>
    );
  }
  return (
    <div className="p-3 rounded-lg border border-border/30 bg-secondary/10">
      <div className={cn("text-[10px] font-bold mb-2", color === "success" ? "text-success" : "text-destructive")}>{label}</div>
      <div className="grid grid-cols-3 gap-2 text-[10px]">
        <div>
          <div className="text-muted-foreground">Signals</div>
          <div className="font-mono font-bold text-foreground">{data.count}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Win Rate</div>
          <div className={cn("font-mono font-bold",
            data.winRate >= 0.60 ? "text-success" : data.winRate >= 0.50 ? "text-yellow-400" : "text-destructive")}>
            {(data.winRate * 100).toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-muted-foreground">W / L</div>
          <div className="font-mono text-foreground">{data.wins} / {data.count - data.wins}</div>
        </div>
      </div>
    </div>
  );
}
