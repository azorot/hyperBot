/**
 * PerformanceTracker — Sharpe, Sortino, profit factor, drawdown, and reporting.
 */
class PerformanceTracker {
    constructor(startingBalance) {
        this.startingBalance = startingBalance;
        this.trades = [];
        this.peakBalance = startingBalance;
        this.maxDrawdown = 0;
        this.maxDrawdownPct = 0;
        this.startTime = Date.now();
    }

    recordTrade(trade) {
        this.trades.push(trade);
        if (trade.balanceAfter > this.peakBalance) {
            this.peakBalance = trade.balanceAfter;
        }
        const dd = this.peakBalance - trade.balanceAfter;
        const ddPct = this.peakBalance > 0 ? dd / this.peakBalance : 0;
        if (ddPct > this.maxDrawdownPct) {
            this.maxDrawdownPct = ddPct;
            this.maxDrawdown = dd;
        }
    }

    getWins() { return this.trades.filter(t => t.pnl > 0); }
    getLosses() { return this.trades.filter(t => t.pnl < 0); }

    getWinRate() {
        if (this.trades.length === 0) return 0;
        return this.getWins().length / this.trades.length;
    }

    getProfitFactor() {
        const grossProfit = this.getWins().reduce((sum, t) => sum + t.pnl, 0);
        const grossLoss = Math.abs(this.getLosses().reduce((sum, t) => sum + t.pnl, 0));
        if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
        return grossProfit / grossLoss;
    }

    calculateSharpe(riskFreeRate = 0) {
        if (this.trades.length < 2) return null;
        const returns = this.trades.map(t => {
            const balanceBefore = t.balanceAfter - t.pnl;
            return balanceBefore > 0 ? t.pnl / balanceBefore : 0;
        });
        const n = returns.length;
        const mean = returns.reduce((a, b) => a + b, 0) / n;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (n - 1);
        const stdDev = Math.sqrt(variance);
        if (stdDev === 0) return mean > 0 ? Infinity : 0;
        const elapsedMs = Date.now() - this.startTime;
        const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
        const tradesPerDay = elapsedDays > 0 ? n / elapsedDays : n;
        const annualizationFactor = Math.sqrt(tradesPerDay * 252);
        return ((mean - riskFreeRate) / stdDev) * annualizationFactor;
    }

    calculateSortino(riskFreeRate = 0) {
        if (this.trades.length < 2) return null;
        const returns = this.trades.map(t => {
            const balanceBefore = t.balanceAfter - t.pnl;
            return balanceBefore > 0 ? t.pnl / balanceBefore : 0;
        });
        const n = returns.length;
        const mean = returns.reduce((a, b) => a + b, 0) / n;
        const downsideReturns = returns.filter(r => r < 0);
        if (downsideReturns.length === 0) return mean > 0 ? Infinity : 0;
        const downsideVariance = downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length;
        const downsideDev = Math.sqrt(downsideVariance);
        if (downsideDev === 0) return mean > 0 ? Infinity : 0;
        return (mean - riskFreeRate) / downsideDev;
    }

    formatDuration(ms) {
        const seconds = Math.floor(ms / 1000) % 60;
        const minutes = Math.floor(ms / (1000 * 60)) % 60;
        const hours = Math.floor(ms / (1000 * 60 * 60));
        if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    }

    getSummary(currentBalance) {
        const wins = this.getWins();
        const losses = this.getLosses();
        const totalPnL = currentBalance - this.startingBalance;
        return {
            runtime: Date.now() - this.startTime,
            totalTrades: this.trades.length,
            wins: wins.length,
            losses: losses.length,
            winRate: this.getWinRate(),
            profitFactor: this.getProfitFactor(),
            sharpeRatio: this.calculateSharpe(),
            sortinoRatio: this.calculateSortino(),
            totalPnL,
            totalPnLPct: (totalPnL / this.startingBalance) * 100,
            avgWin: wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0,
            avgLoss: losses.length > 0 ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0,
            largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.pnl)) : 0,
            largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.pnl)) : 0,
            maxDrawdown: this.maxDrawdown,
            maxDrawdownPct: this.maxDrawdownPct * 100,
            totalFees: this.trades.reduce((sum, t) => sum + (t.totalFees || 0), 0),
            currentBalance
        };
    }

    /**
     * Compact one-liner for quick terminal glancing.
     * Now delegates to printQuickSummary for a richer 3-line dashboard.
     */
    printStatusLine(currentBalance, position, currentPrice, macroTrend, tradeOpenTime) {
        this.printQuickSummary(currentBalance, position, currentPrice, macroTrend, tradeOpenTime);
    }

    /**
     * Compact 3-line boxed dashboard for quick terminal glancing.
     *
     * ╔══ HYPERBOT STATUS ══════════════════════════════════════════╗
     * ║ PnL: +$14.30 (+1.4%) | W:5 L:2 (71%) | PF:2.31 | Sharpe: 1.42
     * ║ Pos: LONG 0.05@65200 uPnL:+$13.20 (2m 30s) | Macro: 🟢 BULL
     * ╚═════════════════════════════════════════════════════════════╝
     */
    printQuickSummary(currentBalance, position, currentPrice, macroTrend, tradeOpenTime) {
        // ── PnL ──
        const pnl = currentBalance - this.startingBalance;
        const pnlPct = (pnl / this.startingBalance) * 100;
        const pnlSign = pnl >= 0 ? '+' : '';

        // ── Win / Loss ──
        const wins = this.getWins().length;
        const losses = this.getLosses().length;
        const total = this.trades.length;
        const wr = total > 0 ? `${(this.getWinRate() * 100).toFixed(0)}%` : '--';

        // ── Profit Factor ──
        const pf = total > 0
            ? (this.getProfitFactor() === Infinity ? '∞' : this.getProfitFactor().toFixed(2))
            : '--';

        // ── Sharpe ──
        const sharpe = this.calculateSharpe();
        const sharpeStr = sharpe !== null ? sharpe.toFixed(2) : '---';

        // ── Position & uPnL ──
        let posStr = 'FLAT';
        let uPnLStr = '';
        let durationStr = '';

        if (position && position.size > 0) {
            posStr = `LONG ${position.size}@${position.entryPrice.toFixed(0)}`;
            if (currentPrice) {
                const uPnL = (currentPrice - position.entryPrice) * position.size;
                const uSign = uPnL >= 0 ? '+' : '';
                uPnLStr = ` uPnL:${uSign}$${uPnL.toFixed(2)}`;
            }
        } else if (position && position.size < 0) {
            posStr = `SHORT ${Math.abs(position.size)}@${position.entryPrice.toFixed(0)}`;
            if (currentPrice) {
                const uPnL = (position.entryPrice - currentPrice) * Math.abs(position.size);
                const uSign = uPnL >= 0 ? '+' : '';
                uPnLStr = ` uPnL:${uSign}$${uPnL.toFixed(2)}`;
            }
        }

        if (tradeOpenTime && position && position.size !== 0) {
            const elapsed = Date.now() - tradeOpenTime;
            durationStr = ` (${this.formatDuration(elapsed)})`;
        }

        // ── Macro Trend ──
        const trend = macroTrend ? macroTrend.trend : 'UNKNOWN';
        let trendLabel;
        let trendEmoji;
        if (trend === 'BULLISH') { trendEmoji = '🟢'; trendLabel = 'BULL'; }
        else if (trend === 'BEARISH') { trendEmoji = '🔴'; trendLabel = 'BEAR'; }
        else { trendEmoji = '⚪'; trendLabel = 'UNKNOWN'; }

        // ── Build lines ──
        const line1 = `║ PnL: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%) | W:${wins} L:${losses} (${wr}) | PF:${pf} | Sharpe: ${sharpeStr}`;
        const line2 = `║ Pos: ${posStr}${uPnLStr}${durationStr} | Macro: ${trendEmoji} ${trendLabel}`;

        // ── Calculate box width (minimum 62, expand if content is wider) ──
        const contentWidth = Math.max(line1.length, line2.length, 62);
        const topBar = `╔══ HYPERBOT STATUS ${'═'.repeat(Math.max(0, contentWidth - 20))}╗`;
        const bottomBar = `╚${'═'.repeat(contentWidth)}╝`;

        console.log(topBar);
        console.log(line1);
        console.log(line2);
        console.log(bottomBar);
    }

    /**
     * Full performance report — used for periodic updates and final summary.
     */
    printReport(currentBalance, tickCount, position, currentPrice, isFinal = false) {
        const s = this.getSummary(currentBalance);
        const unrealizedPnL = position && position.size > 0 && currentPrice
            ? (currentPrice - position.entryPrice) * position.size
            : position && position.size < 0 && currentPrice
            ? (position.entryPrice - currentPrice) * Math.abs(position.size)
            : 0;

        const header = isFinal ? 'SIMULATION COMPLETE — FINAL REPORT' : 'PERFORMANCE REPORT';
        const border = isFinal ? '═' : '─';

        console.log('');
        console.log(`┌${border.repeat(62)}┐`);
        console.log(`│ ${header.padEnd(60)} │`);
        console.log(`├${border.repeat(62)}┤`);
        console.log(`│ Runtime: ${this.formatDuration(s.runtime).padEnd(15)} | Ticks: ${String(tickCount).padEnd(15)}      │`);
        console.log(`├${border.repeat(62)}┤`);
        console.log(`│ Trades: ${String(s.totalTrades).padEnd(5)} | Wins: ${String(s.wins).padEnd(5)} | Losses: ${String(s.losses).padEnd(5)}              │`);
        console.log(`│ Win Rate:       ${s.totalTrades > 0 ? (s.winRate * 100).toFixed(1) + '%' : 'N/A'}                                        │`);
        console.log(`│ Profit Factor:  ${s.totalTrades > 0 ? (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)) : 'N/A'}                                        │`);
        console.log(`│ Sharpe Ratio:   ${s.sharpeRatio !== null ? s.sharpeRatio.toFixed(3) : 'N/A (need 2+ trades)'}                       │`);
        console.log(`│ Sortino Ratio:  ${s.sortinoRatio !== null ? s.sortinoRatio.toFixed(3) : 'N/A (need 2+ trades)'}                       │`);
        console.log(`├${border.repeat(62)}┤`);
        console.log(`│ Avg Win:  $${s.avgWin.toFixed(2).padEnd(12)} | Avg Loss: $${s.avgLoss.toFixed(2).padEnd(12)}    │`);
        console.log(`│ Best:     $${s.largestWin.toFixed(2).padEnd(12)} | Worst:    $${s.largestLoss.toFixed(2).padEnd(12)}    │`);
        console.log(`│ Total Fees Paid: $${s.totalFees.toFixed(4)}                                │`);
        console.log(`├${border.repeat(62)}┤`);
        console.log(`│ Balance:       $${currentBalance.toFixed(2).padEnd(42)} │`);
        console.log(`│ Realized PnL:  ${s.totalPnL >= 0 ? '+' : ''}$${s.totalPnL.toFixed(2)} (${s.totalPnLPct >= 0 ? '+' : ''}${s.totalPnLPct.toFixed(2)}%)${' '.repeat(Math.max(0, 35 - s.totalPnL.toFixed(2).length))} │`);
        console.log(`│ Unrealized:    $${unrealizedPnL.toFixed(2).padEnd(42)} │`);
        console.log(`│ Max Drawdown:  $${s.maxDrawdown.toFixed(2)} (${s.maxDrawdownPct.toFixed(2)}%)${' '.repeat(Math.max(0, 35 - s.maxDrawdown.toFixed(2).length))} │`);

        if (position && position.size !== 0) {
            const side = position.size > 0 ? 'LONG' : 'SHORT';
            console.log(`├${border.repeat(62)}┤`);
            console.log(`│ Open: ${side} ${Math.abs(position.size)} BTC @ $${position.entryPrice.toFixed(2).padEnd(36)} │`);
            if (currentPrice) {
                console.log(`│ Mark:  $${currentPrice.toFixed(2).padEnd(12)} | Unrealized: $${unrealizedPnL.toFixed(2).padEnd(16)} │`);
            }
        }

        // Trade history breakdown (show last 10)
        if (this.trades.length > 0 && isFinal) {
            console.log(`├${border.repeat(62)}┤`);
            console.log(`│ TRADE HISTORY (last ${Math.min(10, this.trades.length)})                                   │`);
            const recent = this.trades.slice(-10);
            recent.forEach((t, i) => {
                const icon = t.pnl >= 0 ? '✅' : '❌';
                const line = `${icon} ${t.side} ${t.size} @ $${t.entryPrice.toFixed(0)}→$${t.exitPrice.toFixed(0)} | Net: $${t.pnl.toFixed(2)}`;
                console.log(`│ ${line.padEnd(60)} │`);
            });
        }

        console.log(`└${border.repeat(62)}┘`);
        console.log('');
    }
}

module.exports = PerformanceTracker;
