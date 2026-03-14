import React, { useState } from "react";
import { useBotPolling } from "@/hooks/use-bot-data";
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
  Bitcoin
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

export default function Dashboard() {
  const { status, analysis, btc, trades, mutations } = useBotPolling();
  const [startBalanceInput, setStartBalanceInput] = useState("20");

  const botData = status.data;
  const marketData = analysis.data;
  const btcData = btc.data;
  const tradesData = trades.data;

  const isRunning = botData?.running || false;

  const handleStart = () => {
    mutations.start.mutate({
      data: {
        mode: "test",
        startingBalance: parseFloat(startBalanceInput) || 20,
      }
    });
  };

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

  // Format data for chart
  const chartData = btcData?.candles.map(c => ({
    time: format(new Date(c.time), 'HH:mm'),
    close: c.close,
    volume: c.volume,
    isUp: c.close >= c.open
  })) || [];

  return (
    <div className="min-h-screen bg-background text-foreground p-4 md:p-6 lg:p-8 space-y-6 max-w-[1600px] mx-auto">
      
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
                {isRunning ? "SYSTEM_ACTIVE" : "SYSTEM_STANDBY"} • v1.0.4
              </span>
            </div>
          </div>
        </div>

        {/* Global BTC Ticker */}
        <div className="flex items-center gap-4 bg-card border border-border/50 rounded-xl px-4 py-2 shadow-lg">
          <Bitcoin className="w-5 h-5 text-warning" />
          <div className="flex flex-col">
            <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">BTC/USD (Global)</span>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-mono font-bold">{formatCurrency(btcData?.currentPrice)}</span>
              <span className={cn("text-xs font-mono font-medium", 
                (btcData?.change5m || 0) >= 0 ? "text-success" : "text-destructive"
              )}>
                {(btcData?.change5m || 0) >= 0 ? "+" : ""}{formatPct(btcData?.change5m)} (5m)
              </span>
            </div>
          </div>
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
            <div className="p-3 bg-primary/10 rounded-full text-primary">
              <Wallet className="w-5 h-5" />
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
              subValue={`${botData?.winningTrades}W / ${botData?.losingTrades}L`}
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
              
              <div className="flex flex-col gap-2">
                <label className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Configuration</label>
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground font-mono">$</span>
                    <input 
                      type="number" 
                      value={startBalanceInput}
                      onChange={(e) => setStartBalanceInput(e.target.value)}
                      disabled={isRunning}
                      className="w-full bg-input border border-border rounded-md h-10 pl-7 pr-3 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary disabled:opacity-50"
                    />
                  </div>
                  <TerminalBadge variant="warning" className="h-10 px-4 text-xs">TEST MODE</TerminalBadge>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <TerminalButton 
                  onClick={handleStart} 
                  disabled={isRunning || mutations.start.isPending}
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
              <TerminalCardTitle><Activity className="w-4 h-4"/> Live Target Signal</TerminalCardTitle>
              {isRunning && <span className="flex h-2 w-2 relative"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span></span>}
            </TerminalCardHeader>
            <TerminalCardContent className="p-6 flex flex-col items-center justify-center text-center space-y-6">
              
              <AnimatePresence mode="wait">
                <motion.div 
                  key={marketData?.signal || 'NONE'}
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.8, opacity: 0 }}
                  className={cn(
                    "px-8 py-6 rounded-2xl border-2 w-full",
                    marketData?.signal === 'BUY_YES' ? "bg-success/10 border-success text-success box-glow-primary" :
                    marketData?.signal === 'BUY_NO' ? "bg-destructive/10 border-destructive text-destructive box-glow-destructive" :
                    "bg-secondary/50 border-border text-muted-foreground"
                  )}
                >
                  <div className="text-sm font-bold tracking-widest uppercase mb-2 opacity-80">Action Directive</div>
                  <div className="text-4xl font-black tracking-tight font-mono">
                    {marketData?.signal ? marketData.signal.replace('_', ' ') : 'NO TRADE'}
                  </div>
                </motion.div>
              </AnimatePresence>

              <div className="grid grid-cols-2 gap-4 w-full">
                <div className="p-4 bg-secondary/30 rounded-lg border border-border/50 text-left">
                  <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">True Prob (Est)</div>
                  <div className="text-xl font-mono text-foreground">{formatPct(marketData?.estimatedTrueProb)}</div>
                </div>
                <div className="p-4 bg-secondary/30 rounded-lg border border-border/50 text-left">
                  <div className="text-[10px] text-muted-foreground uppercase font-bold mb-1">Market Edge</div>
                  <div className={cn("text-xl font-mono", (marketData?.edge || 0) > 0.05 ? "text-success text-glow-success" : "text-foreground")}>
                    {formatPct(marketData?.edge)}
                  </div>
                </div>
              </div>
            </TerminalCardContent>
          </TerminalCard>
        </div>

        {/* MIDDLE COL: Strategy Metrics */}
        <div className="space-y-6">
          <TerminalCard>
            <TerminalCardHeader>
              <TerminalCardTitle><BarChart3 className="w-4 h-4"/> LMSR Market State</TerminalCardTitle>
            </TerminalCardHeader>
            <TerminalCardContent className="space-y-4">
              <div className="bg-secondary/20 p-3 rounded text-xs font-mono text-muted-foreground mb-2 flex items-center justify-between border border-border/30">
                <span>C(q) = b * ln(Σ exp(q_i/b))</span>
                <span className="text-[10px] px-2 py-0.5 bg-secondary rounded">Polymarket Core Math</span>
              </div>
              
              <div className="grid grid-cols-3 gap-2">
                <ValueDisplay label="Q_YES Shares" value={Math.floor(marketData?.qYes || 0)} className="bg-secondary/10 p-3 rounded-lg border border-border/20" />
                <ValueDisplay label="Q_NO Shares" value={Math.floor(marketData?.qNo || 0)} className="bg-secondary/10 p-3 rounded-lg border border-border/20" />
                <ValueDisplay label="Liquidity (b)" value={marketData?.liquidityParam?.toFixed(1) || "---"} className="bg-secondary/10 p-3 rounded-lg border border-border/20" />
              </div>
              
              <div className="pt-2">
                <ValueDisplay label="Current Contract Price" value={formatCurrency(marketData?.currentPrice)} highlight="none" />
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
          <TerminalCard className="h-full flex flex-col">
            <TerminalCardHeader>
              <TerminalCardTitle><TrendingUp className="w-4 h-4"/> BTC 5M Price Action</TerminalCardTitle>
            </TerminalCardHeader>
            <TerminalCardContent className="flex-1 min-h-[300px] p-2">
              {chartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
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
                <div className="h-full flex items-center justify-center text-muted-foreground text-sm font-mono">
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
                    <td className="px-4 py-3">
                      <TerminalBadge variant={trade.status === 'open' ? 'warning' : 'default'} className="bg-transparent">
                        {trade.status}
                      </TerminalBadge>
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
                      {trade.status === 'open' ? '---' : formatCurrency(trade.pnl)}
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
