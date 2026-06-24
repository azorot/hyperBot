const fs = require('fs');
const { startFeed, currentSnapshot, macroTrend, refreshMacroTrend, fundingState, refreshFunding, vwapState, getVWAP, tradeListeners } = require('./feed.js');
const VirtualState = require('./state.js');
const MatchingEngine = require('./engine.js');
const { fetchHistoricalOHLC, loadAndSyncCandles, formatCandleArrays } = require('./history');
const PerformanceTracker = require('./stats.js');
const LOG_FILE = `sim_log_multi_${new Date().toISOString().slice(0, 10)}.txt`;
const LEDGER_FILE = 'trade_ledger_multi.jsonl';
const COMPLETED_TRADES_FILE = 'completed_trades_multi.jsonl';

// Clean old files on boot
if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
if (fs.existsSync(LEDGER_FILE)) fs.unlinkSync(LEDGER_FILE);
if (fs.existsSync(COMPLETED_TRADES_FILE)) fs.unlinkSync(COMPLETED_TRADES_FILE);

// ═══════════════════════════════════════════════════════════════
//  V5.01 MULTI-SIMULATOR CONFIG
// ═══════════════════════════════════════════════════════════════
const STARTING_BALANCE = 1000.0;       // USDC
const RISK_PER_TRADE_PCT = 0.02;       // 2% of equity per trade
const MAX_LEVERAGE = 3;                // Hard cap
const EQUITY_FLOOR = 80.0;             // Kill switch

// OLD: const VWAP_PROXIMITY_PCT = 0.001;      // Price must be within 0.1% of VWAP for a "touch"
const VWAP_PROXIMITY_PCT = 0.002;      // Widen entry to 0.2% variance to capture front-running volume
const CVD_SPIKE_WINDOW_MS = 5000;      // 5s window for CVD spike detection
// OLD: const CVD_SPIKE_THRESHOLD = 2.0;       // Spike must be 2x the average 60s CVD rate
const CVD_SPIKE_THRESHOLD = 1.5;       // Lower spike to 1.5x of baseline total kinetic background noise

const HARD_STOP_PCT = 0.005;           // 0.5% hard stop
const TRAIL_ACTIVATION_PCT = 0.005;    // Trail activates at 0.5% profit
const COOLDOWN_MS = 5 * 60 * 1000;     // 5 min cooldown
// const MIN_VOLUME_THRESHOLD = 10.0;     // 10 BTC minimum volume in 60s window
const MIN_VOLUME_THRESHOLD = 3.0;      // Lowered to 3.0 BTC minimum volume in 60s window

const FUNDING_CHECK_MINUTE = 50;
const TRAIL_CB_FUNDING_BAD = 0.0005;

const SCAN_INTERVAL_MS = 15 * 1000;    // Faster scans for scalping
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// Shared indicators
const indicators = { sma200: null, atr: null, fastAtr: null, rsi: null, lastRefresh: null };

function ts() { return new Date().toISOString().slice(11, 19); }

function formatDuration(ms) {
    const s = Math.floor(ms / 1000) % 60;
    const m = Math.floor(ms / (1000 * 60)) % 60;
    const h = Math.floor(ms / (1000 * 60 * 60));
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

// ═══════════════════════════════════════════════════════════════
//  STRATEGY INSTANCE CLASS
// ═══════════════════════════════════════════════════════════════
class StrategyInstance {
    constructor(volMultiplier) {
        this.volMultiplier = volMultiplier;
        this.name = volMultiplier.toFixed(4);
        this.ledgerFile = 'trade_ledger_multi.jsonl';

        // Pass custom ledger file and custom post-trade reset callback
        this.state = new VirtualState(STARTING_BALANCE, this.ledgerFile, () => this.flushTradeBuffer());
        this.state.volMultiplier = volMultiplier; // Identify simulation param in VirtualState
        this.engine = new MatchingEngine(this.state);
        this.tracker = new PerformanceTracker(STARTING_BALANCE);

        this.tickCount = 0;
        this.lastTradeCount = 0;
        this.lastSweepDay = new Date().getUTCDate();
        this.lastLiqWarnTime = 0;
        this.lastFundingCheck = 0;

        // Trail state
        this.currentStopPrice = null;
        this.trailActive = false;
        this.trailHighWater = null;
        this.currentCallback = null;
        this.fundingOverride = false;
        this.dynamicHardStop = null;
        this.breakEvenTriggered = false;

        // CVD baseline for spike detection
        this.cvdBaseline = { avgRate: 0, lastCalc: 0 };

        // Local trade buffer
        this.tradeBuffer = [];
    }

    logSignal(type, details) {
        console.log('');
        console.log(`[${ts()}] ┌─── ${type} ──────────────────────────────────────────`);
        details.forEach(line => { if (line) console.log(`[${ts()}] │ ${line}`); });
        console.log(`[${ts()}] └──────────────────────────────────────────────────────────`);
    }

    flushTradeBuffer() {
        this.tradeBuffer = [];
        console.log(`[Feed] [${this.name}] Trade buffer flushed to prevent ghost volume entries.`);
    }

    addTrade(trade) {
        this.tradeBuffer.push(trade);
        const now = Date.now();
        // Keep 60s rolling window
        this.tradeBuffer = this.tradeBuffer.filter(t => (now - t.time) <= 60000);
    }

    getVolumeMetrics() {
        let buyVolume = 0;
        let sellVolume = 0;
        this.tradeBuffer.forEach(t => {
            if (t.side === 'B') buyVolume += t.size;
            if (t.side === 'A') sellVolume += t.size;
        });
        return { buyVolume, sellVolume };
    }

    getCVD() {
        let cvd = 0;
        this.tradeBuffer.forEach(t => {
            if (t.side === 'B') cvd += t.size;
            else if (t.side === 'A') cvd -= t.size;
        });
        return cvd;
    }

    getCVDSpike(windowMs = 5000) {
        const cutoff = Date.now() - windowMs;
        let spike = 0;
        let volume = 0;
        this.tradeBuffer.forEach(t => {
            if (t.time >= cutoff) {
                if (t.side === 'B') spike += t.size;
                else if (t.side === 'A') spike -= t.size;
                volume += t.size;
            }
        });
        return { spike, volume };
    }

    getSpikeDelta(windowMs = 5000) {
        if (this.tradeBuffer.length === 0) return 0;
        const cutoff = Date.now() - windowMs;
        const windowTrades = this.tradeBuffer.filter(t => t.time >= cutoff);
        if (windowTrades.length === 0) return 0;
        const oldestPrice = windowTrades[0].price;
        const newestPrice = windowTrades[windowTrades.length - 1].price;
        return newestPrice - oldestPrice;
    }

    hasMinVolume(minVol = 10.0) {
        const { buyVolume, sellVolume } = this.getVolumeMetrics();
        return (buyVolume + sellVolume) >= minVol;
    }

    updateCVDBaseline() {
        const now = Date.now();
        if (now - this.cvdBaseline.lastCalc < 10000) return;

        const { buyVolume, sellVolume } = this.getVolumeMetrics();
        const totalVol = buyVolume + sellVolume;
        // OLD (hallucinated division-by-zero spike risk on balanced volumes):
        // this.cvdBaseline.avgRate = totalVol > 0 ? Math.abs(buyVolume - sellVolume) / 60 : 0;
        // Measure total kinetic energy of the market, not net delta.
        this.cvdBaseline.avgRate = totalVol > 0 ? totalVol / 60 : 0;
        this.cvdBaseline.lastCalc = now;
    }

    calculatePositionSize(equity, entryPrice, stopDistancePct) {
        if (stopDistancePct <= 0 || entryPrice <= 0 || equity <= 0) return 0;
        const stopDollar = entryPrice * stopDistancePct;
        const riskUSDC = equity * RISK_PER_TRADE_PCT;
        let sizeBTC = riskUSDC / stopDollar;

        // Leverage ceiling
        const maxNotional = equity * MAX_LEVERAGE;
        const maxSize = maxNotional / entryPrice;
        if (sizeBTC > maxSize) {
            sizeBTC = maxSize;
            console.log(`[Risk] Leverage cap applied: ${MAX_LEVERAGE}x max → ${sizeBTC.toFixed(3)} BTC`);
        }

        // Fee viability
        const fees = sizeBTC * entryPrice * 0.00045 * 2;
        if (fees > riskUSDC * 0.50) {
            console.log(`[Risk] Fees $${fees.toFixed(2)} = ${((fees / riskUSDC) * 100).toFixed(0)}% of risk $${riskUSDC.toFixed(2)}`);
        }

        const rounded = Math.floor(sizeBTC * 1000) / 1000;
        if (rounded < 0.001) return 0;

        const notional = rounded * entryPrice;
        console.log(`[Risk] Equity: $${equity.toFixed(2)} | Risk: $${riskUSDC.toFixed(2)} | Size: ${rounded} BTC ($${notional.toFixed(0)}) | Lev: ${(notional / equity).toFixed(1)}x`);
        return rounded;
    }

    checkMicroSqueezeExit(midPrice, position) {
        if (position.size === 0 || !this.state.tradeOpenTime) return false;

        const isLong = position.size > 0;
        const side = isLong ? 'LONG' : 'SHORT';
        const entry = position.entryPrice;
        const elapsed = Date.now() - this.state.tradeOpenTime;

        // --- 15-MINUTE KILL SWITCH ---
        if (elapsed >= 900000) {
            const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
            this.logSignal('15-MINUTE KILL SWITCH', [
                `⏰ Time limit reached (15m). Force closing position via Post-Only Limit Order.`,
                `${side} entry: $${entry.toFixed(2)} | PnL: $${pnl.toFixed(2)}`,
                `Action: POST LIMIT EXIT @ spread`
            ]);
            this.state.tradeReason = 'TIMEOUT_15M';
            this.engine.executeMarketOrder(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
            return true;
        }

        // --- HARD STOP ---
        const hardHit = isLong ? midPrice <= this.dynamicHardStop : midPrice >= this.dynamicHardStop;
        if (hardHit) {
            const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
            this.logSignal('HARD STOP-LOSS', [
                `⛔ Price $${midPrice.toFixed(2)} breached hard stop $${this.dynamicHardStop.toFixed(2)}`,
                `${side} entry: $${entry.toFixed(2)} | PnL: $${pnl.toFixed(2)} | Elapsed: ${formatDuration(elapsed)}`,
                `Action: CLOSE @ market (Taker)`
            ]);
            this.state.tradeReason = 'HARD_STOP';
            this.engine.executeMarketOrder(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);

            this.state.setCooldown('LONG', COOLDOWN_MS);
            this.state.setCooldown('SHORT', COOLDOWN_MS);
            this.resetTradeState();
            return true;
        }

        // --- TIME-DECAY TRAILING STOP ---
        if (this.trailActive) {
            // ─── TIME-BASED MOMENTUM INVALIDATION (The 60s Rule) ───
            if (elapsed >= 60000 && !this.state.clearedFees) {
                const uPnL = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);

                // If the trade is fundamentally underwater after 60 seconds, the momentum failed.
                if (uPnL < 0) {
                    this.logSignal('MOMENTUM INVALIDATION — SCRATCH TRADE', [
                        `⏱️ Trade has been underwater for 60s without kinetic follow-through.`,
                        `The setup is dead. Aborting to limit-exit and preserve capital.`,
                        `PnL at invalidation: $${uPnL.toFixed(2)}`
                    ]);

                    this.state.tradeReason = 'MOMENTUM_INVALIDATION';

                    // Deploy a Post-Only Maker limit order to trap the spread. 
                    // Do not pay the taker fee to fix a dead trade.
                    this.engine.postLimitExit(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
                    return true;
                }
            }

            // Calculate callback rate using custom volMultiplier instead of hardcoded 0.0015
            const initStop = this.currentCallback || this.volMultiplier;
            let cb = initStop;

            // Linear decay
            if (elapsed > 600000) {
                cb = 0.0002;
            } else if (elapsed > 60000) {
                const ratio = (elapsed - 60000) / (600000 - 60000);
                cb = initStop - ratio * (initStop - 0.0002);
                if (cb < 0.0002) cb = 0.0002;
            }

            // Taker fee break-even check
            const clearsFees = this.engine.clearsTakerFees(entry, midPrice, side);
            if (clearsFees && !this.state.clearedFees) {
                this.state.clearedFees = true;
                console.log(`[${ts()}] [Consider] Price action has cleared taker fee threshold ($${this.engine.getBreakEvenPrice(entry, side).toFixed(2)}). Trailing stop is now active and moving.`);
            }

            // Only allowed to move trailing stop if we have cleared taker fees
            if (this.state.clearedFees) {
                if (isLong) {
                    if (midPrice > this.trailHighWater) this.trailHighWater = midPrice;
                    const ns = this.trailHighWater * (1 - cb);
                    if (ns > this.currentStopPrice) this.currentStopPrice = ns;
                } else {
                    if (midPrice < this.trailHighWater) this.trailHighWater = midPrice;
                    const ns = this.trailHighWater * (1 + cb);
                    if (ns < this.currentStopPrice) this.currentStopPrice = ns;
                }
            }

            const trailHit = isLong ? midPrice <= this.currentStopPrice : midPrice >= this.currentStopPrice;
            if (trailHit) {
                const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
                this.logSignal('TRAIL STOP EXIT', [
                    `📉 Price $${midPrice.toFixed(2)} breached trail $${this.currentStopPrice.toFixed(2)}`,
                    `PnL: $${pnl.toFixed(2)} | Hold: ${formatDuration(elapsed)} | Callback: ${(cb * 100).toFixed(4)}%`,
                    `Cleared Fees: ${this.state.clearedFees ? 'YES' : 'NO'}`
                ]);
                this.state.tradeReason = this.state.clearedFees ? 'TRAIL_EXIT' : 'FEE_THRESHOLD_FAILURE';
                this.engine.postLimitExit(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
                return true;
            }
        }

        return false;
    }

    async checkFundingIntercept(position) {
        if (position.size === 0) return;
        const now = new Date();
        const minute = now.getUTCMinutes();
        if (minute < FUNDING_CHECK_MINUTE || minute > 55) return;
        if (now.getTime() - this.lastFundingCheck < 5 * 60000) return;
        this.lastFundingCheck = now.getTime();

        if (fundingState.rate === null || fundingState.direction === 'UNKNOWN') return;

        const isLong = position.size > 0;
        const dir = fundingState.direction;
        console.log(`[${ts()}] [FUNDING] T-${60 - minute}min | Rate: ${(fundingState.rate * 100).toFixed(4)}% | ${dir}`);

        const favorableForLong = dir === 'NEGATIVE';
        const favorableForShort = dir === 'POSITIVE';

        if ((isLong && !favorableForLong) || (!isLong && !favorableForShort)) {
            console.log(`[${ts()}] [FUNDING] Adverse funding. Tightening trail to ${(TRAIL_CB_FUNDING_BAD * 100).toFixed(2)}%`);
            if (this.trailActive) { this.currentCallback = TRAIL_CB_FUNDING_BAD; this.fundingOverride = true; }
        } else {
            console.log(`[${ts()}] [FUNDING] Favorable funding. Holding.`);
            this.fundingOverride = false;
        }
    }

    async checkVWAPEntry(midPrice, spread) {
        const vwap = vwapState.vwap;
        if (!vwap) return false;

        const vwapDist = (midPrice - vwap) / vwap;
        const vwapTouching = Math.abs(vwapDist) <= VWAP_PROXIMITY_PCT;
        if (!vwapTouching) return false;

        const priceAboveVWAP = midPrice > vwap;
        const direction = priceAboveVWAP ? 'LONG' : 'SHORT';

        // Cooldown check
        if (this.state.isCoolingDown(direction)) return false;

        // --- ATR Volatility Hurdle (Using volMultiplier instead of 0.0015) ---
        const currentATR = indicators.fastAtr || indicators.atr;
        if (!currentATR) return false;
        const atrHurdle = midPrice * this.volMultiplier;
        if (currentATR <= atrHurdle) {
            console.log(`[${ts()}] [Consider] Touched VWAP, but volatility is too low. ATR $${currentATR.toFixed(2)} <= Hurdle $${atrHurdle.toFixed(2)}. Stand down.`);
            return false;
        }

        console.log(`[${ts()}] [Consider] Touched VWAP. Volatility is sufficient ($${currentATR.toFixed(2)} > $${atrHurdle.toFixed(2)}). Checking order flow...`);

        // CVD spike detection
        const { spike, volume } = this.getCVDSpike(CVD_SPIKE_WINDOW_MS);
        const cvd60s = this.getCVD();

        const spikePerSec = Math.abs(spike) / (CVD_SPIKE_WINDOW_MS / 1000);
        const spikeRatio = this.cvdBaseline.avgRate > 0 ? spikePerSec / this.cvdBaseline.avgRate : 0;

        const spikeValid = direction === 'LONG'
            ? spike > 0 && spikeRatio >= CVD_SPIKE_THRESHOLD
            : spike < 0 && spikeRatio >= CVD_SPIKE_THRESHOLD;

        if (!spikeValid) {
            if (Math.abs(spikeRatio) >= 1.0) {
                console.log(`[${ts()}] [Consider] Order flow spike detected, but invalid setup. Ratio: ${spikeRatio.toFixed(1)}x, Direction matches: ${spikeValid}. Stand down.`);
            }
            return false;
        }

        const spikeDelta = this.getSpikeDelta(CVD_SPIKE_WINDOW_MS);
        const priceMovingAway = direction === 'LONG' ? spikeDelta > 0 : spikeDelta < 0;
        if (!priceMovingAway) {
            console.log(`[${ts()}] [Consider] CVD spiked in direction (${direction}) but price momentum delta is adverse ($${spikeDelta.toFixed(2)}). Risking liquidity traps. Stand down.`);
            return false;
        }

        console.log(`[${ts()}] [Consider] CONFLUENCE ACHIEVED: VWAP proximity + CVD Spike (${spikeRatio.toFixed(1)}x) + Price Momentum Confirmation ($${spikeDelta.toFixed(2)}). Sizing position...`);

        // --- NEW MACRO TREND GATE ---
        const isMacroBearish = macroTrend.h1 === 'BEARISH' || macroTrend.d1 === 'BEARISH';
        const isMacroBullish = macroTrend.h1 === 'BULLISH' || macroTrend.d1 === 'BULLISH';

        // BLOCK ENTRY IF TREND IS CONTRARIAN
        const isLong = direction === 'LONG';
        if (isLong && isMacroBearish) {
            this.logSignal('ENTRY BLOCKED', ['Macro trend BEARISH. Ignoring Long signal.']);
            return false; // Force kill the entry
        }
        if (!isLong && isMacroBullish) {
            this.logSignal('ENTRY BLOCKED', ['Macro trend BULLISH. Ignoring Short signal.']);
            return false; // Force kill the entry
        }

        const effectiveStopPct = indicators.atr ? (1.5 * indicators.atr) / midPrice : HARD_STOP_PCT;
        const tradeSize = this.calculatePositionSize(this.state.getBalance(), midPrice, effectiveStopPct);
        if (tradeSize === 0) {
            console.log(`[${ts()}] [RISK] Size too small — skipping.`);
            return false;
        }

        const hardStop = direction === 'LONG'
            ? midPrice * (1 - effectiveStopPct)
            : midPrice * (1 + effectiveStopPct);

        this.dynamicHardStop = hardStop;

        const fastAtr = indicators.fastAtr || indicators.atr || 30.0;
        const relATR = fastAtr / midPrice;
        const baselineRelATR = 0.0005; // 0.05%
        let adjustedInitialStop = this.volMultiplier * (relATR / baselineRelATR);
        adjustedInitialStop = Math.max(0.0002, Math.min(0.0050, adjustedInitialStop));

        this.logSignal(`ENTRY — VWAP ${direction === 'LONG' ? 'BOUNCE BUY' : 'REJECTION SELL'} (${direction})`, [
            `✓ VWAP: $${vwap.toFixed(2)} | Price: $${midPrice.toFixed(2)} | Dist: ${(vwapDist * 100).toFixed(3)}%`,
            `✓ CVD Spike: ${spike.toFixed(2)} BTC in ${CVD_SPIKE_WINDOW_MS / 1000}s | Ratio: ${spikeRatio.toFixed(1)}x baseline`,
            `✓ CVD 60s: ${cvd60s.toFixed(2)} | Direction: ${spike > 0 ? 'BUY PRESSURE' : 'SELL PRESSURE'}`,
            `✓ Volume in spike: ${volume.toFixed(2)} BTC`,
            `✓ Macro: 1H ${macroTrend.trend} | 1D ${macroTrend.dailyTrend || 'N/A'} | Funding: ${fundingState.direction}`,
            `✓ Size: ${tradeSize} BTC ($${(tradeSize * midPrice).toFixed(0)} USDC)`,
            `Action: OPEN ${direction} ${tradeSize} BTC @ ~$${midPrice.toFixed(2)}`,
            `Hard stop: $${hardStop.toFixed(2)} (${(effectiveStopPct * 100).toFixed(1)}%)`,
            `Dynamic Initial Stop: ${(adjustedInitialStop * 100).toFixed(4)}% (Time-Decay: M1 ${(adjustedInitialStop * 100).toFixed(3)}% → M10 0.020%)`
        ]);

        this.state.tradeReason = JSON.stringify({
            type: `VWAP_${direction === 'LONG' ? 'BOUNCE' : 'REJECTION'}`,
            confluence: { vwapDist, cvdSpike: spike, cvdRatio: spikeRatio, spread, volume }
        });

        if (direction === 'LONG') {
            this.engine.executeMarketOrder('buy', tradeSize, currentSnapshot);
        } else {
            this.engine.executeMarketOrder('sell', tradeSize, currentSnapshot);
        }

        this.state.targetExit = null;
        this.trailActive = true;
        this.trailHighWater = midPrice;
        this.currentCallback = adjustedInitialStop;
        this.currentStopPrice = direction === 'LONG'
            ? midPrice * (1 - adjustedInitialStop)
            : midPrice * (1 + adjustedInitialStop);
        this.fundingOverride = false;
        return true;
    }


    resetTradeState() {
        this.state.targetExit = null;
        this.currentStopPrice = null;
        this.trailActive = false;
        this.trailHighWater = null;
        this.currentCallback = null;
        this.fundingOverride = false;
        this.dynamicHardStop = null;
        this.breakEvenTriggered = false;
    }

    onTick(bestAsk, bestBid) {
        this.tickCount++;
        const midPrice = (bestAsk + bestBid) / 2;
        const spread = bestAsk - bestBid;
        const position = this.state.getPosition();

        this.updateCVDBaseline();

        // ═══ ACTIVE LIMIT EXIT ORDER CHECK ═══
        if (this.engine.activeLimitOrder) {
            const filled = this.engine.updateLimitExit(currentSnapshot);
            if (filled) {
                this.resetTradeState();
            }
            return;
        }

        // ═══ CIRCUIT BREAKER ═══
        if (this.state.isHalted()) {
            if (this.state.killed) {
                this.logSignal('⛔ EQUITY FLOOR — EMERGENCY SHUTDOWN', [`Balance: $${this.state.getBalance().toFixed(2)} <= $${EQUITY_FLOOR}`]);
                if (position.size !== 0) {
                    this.state.tradeReason = 'EQUITY_FLOOR';
                    this.engine.executeMarketOrder(position.size > 0 ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
                    this.resetTradeState();
                }
                return;
            }
            return;
        }

        // ═══ EXIT ═══
        if (position.size !== 0) {
            this.checkFundingIntercept(position).catch(() => { });
            if (this.checkMicroSqueezeExit(midPrice, position)) return;
        }

        // ═══ ENTRY ═══
        if (position.size === 0) {
            if (this.hasMinVolume(MIN_VOLUME_THRESHOLD)) {
                this.checkVWAPEntry(midPrice, spread).catch(err => {
                    console.error(`[Entry Error]:`, err.message);
                });
            }
        }

        // ═══ TRADE RECORDING ═══
        if (this.state.completedTrades.length > this.lastTradeCount) {
            for (let i = this.lastTradeCount; i < this.state.completedTrades.length; i++) {
                const t = this.state.completedTrades[i];
                t.volMultiplier = this.volMultiplier; // Assign volMultiplier to completed trade object
                this.tracker.recordTrade(t);
                fs.appendFileSync(COMPLETED_TRADES_FILE, JSON.stringify(t) + '\n');
                let entryType = 'N/A';
                try { entryType = JSON.parse(t.entryReason).type; } catch { entryType = t.entryReason || 'N/A'; }

                this.logSignal('TRADE CLOSED', [
                    `${t.side} ${t.size} BTC | ${entryType}`,
                    `$${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${t.exitReason || 'N/A'} | ${t.durationMs ? formatDuration(t.durationMs) : '?'}`,
                    `Gross: $${t.grossPnl.toFixed(2)} | Fees: $${t.totalFees.toFixed(4)} | Net: $${t.pnl.toFixed(2)} ${t.pnl >= 0 ? '✅' : '❌'}`,
                    `Balance: $${t.balanceAfter.toFixed(2)} | W:${this.tracker.getWins().length} L:${this.tracker.getLosses().length} (${(this.tracker.getWinRate() * 100).toFixed(0)}%)`
                ]);
            }
            this.lastTradeCount = this.state.completedTrades.length;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  GLOBAL INDICATORS AND MAIN SIMULATOR COORDINATOR
// ═══════════════════════════════════════════════════════════════
function calculateSMA(closes, period) {
    if (!closes || closes.length < period) return null;
    return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateATR(highs, lows, closes, period = 14) {
    if (!highs || highs.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < highs.length; i++) {
        trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calculateRSI(closes, period = 14) {
    if (!closes || closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        if (d > 0) gains += d; else losses -= d;
    }
    if (losses === 0) return 100;
    return 100 - (100 / (1 + (gains / period) / (losses / period)));
}

async function refreshIndicators() {
    try {
        const rawCandles = await loadAndSyncCandles('BTC', '1m', 10000);
        if (!rawCandles || rawCandles.length === 0) return;

        const data = formatCandleArrays(rawCandles);
        indicators.sma200 = calculateSMA(data.closes, 200);
        indicators.atr = calculateATR(data.highs, data.lows, data.closes);

        const highs60 = data.highs.slice(-60);
        const lows60 = data.lows.slice(-60);
        const closes60 = data.closes.slice(-60);
        indicators.fastAtr = calculateATR(highs60, lows60, closes60, 14);

        indicators.rsi = calculateRSI(data.closes);
        indicators.lastRefresh = Date.now();
        console.log(`[${ts()}] [Refresh] SMA200: $${indicators.sma200?.toFixed(2)} | RSI: ${indicators.rsi?.toFixed(1)} | ATR: $${indicators.atr?.toFixed(2)} | Fast ATR (1H): $${indicators.fastAtr?.toFixed(2)}`);
    } catch (err) { console.error(`[${ts()}] [Refresh] Error:`, err.message); }
}

const multipliers = [0.0004, 0.0005, 0.0006, 0.0007, 0.0008, 0.0009, 0.0010];
const simulations = multipliers.map(m => new StrategyInstance(m));

// Pipe trades to each simulation
let lastTradeMsgTime = 0;
tradeListeners.push((trade) => {
    const currentTime = Date.now();
    if (lastTradeMsgTime > 0) {
        const delay = currentTime - lastTradeMsgTime;
        if (delay > 2000) {
            originalLog(`[Pipeline Debug] WS trade stall detected in multi_sim: ${delay}ms. Timestamp: ${currentTime}`);
        }
    }
    lastTradeMsgTime = currentTime;
    simulations.forEach(sim => sim.addTrade(trade));
});



let currentPrefix = null;
let activeSignalPrefix = null;
const originalLog = console.log;
const originalError = console.error;

console.log = function (...args) {
    const line = args.join(' ');
    const formattedLine = currentPrefix ? `[${currentPrefix}] ${line}` : line;

    // Strip ANSI escape codes to keep the raw log file clean and legible
    const cleanLine = formattedLine.replace(/\x1b\[[0-9;]*m/g, '');
    fs.appendFileSync(LOG_FILE, cleanLine + '\n');

    if (currentPrefix) {
        // Detect start of signal box
        if (line.includes('┌───')) {
            activeSignalPrefix = currentPrefix;
        }

        if (activeSignalPrefix === currentPrefix) {
            // We are inside a signal box for this simulation, print it to terminal!
            originalLog.call(console, `\x1b[36m[${currentPrefix}]\x1b[0m ${line}`);
        } else {
            // Check for important messages, warnings, or position status lines
            if (line.includes('[WARNING]') || line.includes('[Risk]') || line.includes('[Engine]') || line.includes('[Cooldown]') || line.includes('[State]') || line.includes('[Funding]')) {
                originalLog.call(console, `\x1b[36m[${currentPrefix}]\x1b[0m ${line}`);
            } else if (line.includes('Position:') || line.includes('Decay CB:')) {
                // Real-time active position updates
                originalLog.call(console, `\x1b[36m[${currentPrefix}]\x1b[0m ${line}`);
            }
        }

        // Detect end of signal box
        if (line.includes('└─────')) {
            activeSignalPrefix = null;
        }
    } else {
        originalLog.apply(console, args);
    }
};

console.error = function (...args) {
    const line = args.join(' ');
    const formattedLine = currentPrefix ? `[ERROR] [${currentPrefix}] ${line}` : `[ERROR] ${line}`;
    fs.appendFileSync(LOG_FILE, formattedLine + '\n');
    originalError.apply(console, args);
};

function handleShutdown() {
    originalLog('\n╔════════════════════════════════════════════════════════════════╗');
    originalLog('║                     FINAL SIMULATION REPORTS                   ║');
    originalLog('╚════════════════════════════════════════════════════════════════╝');

    simulations.forEach(sim => {
        let price = 0;
        if (currentSnapshot.asks?.length > 0) price = parseFloat(currentSnapshot.asks[0].px);

        currentPrefix = sim.name;
        sim.tracker.printReport(sim.state.getBalance(), sim.tickCount, sim.state.getPosition(), price, true);
        currentPrefix = null;

        originalLog(`\n--- Simulation: ${sim.name} ---`);
        const stats = sim.tracker;
        const wins = stats.getWins().length;
        const losses = stats.getLosses().length;
        const total = stats.trades.length;
        const wr = total > 0 ? ((wins / total) * 100).toFixed(1) : 'N/A';
        const netP = (sim.state.getBalance() - STARTING_BALANCE).toFixed(2);

        originalLog(`Net PnL:        $${netP} (${(netP / STARTING_BALANCE * 100).toFixed(2)}%)`);
        originalLog(`Trades:         ${total} (W: ${wins} / L: ${losses}) | Win Rate: ${wr}%`);
        originalLog(`Profit Factor:  ${stats.getProfitFactor()}`);
        originalLog(`Sharpe Ratio:   ${stats.calculateSharpe()?.toFixed(3) || 'N/A'}`);
        originalLog(`Sortino Ratio:  ${stats.calculateSortino()?.toFixed(3) || 'N/A'}`);
        originalLog(`Log File:       ${LOG_FILE}`);
        originalLog(`Ledger:         ${sim.ledgerFile}`);
    });

    process.exit(0);
}

function printConsolidatedScan(price, spread) {
    const vwap = vwapState.vwap;
    const cvd = simulations[0].getCVD();
    const { spike, volume } = simulations[0].getCVDSpike(CVD_SPIKE_WINDOW_MS);
    const { buyVolume, sellVolume } = simulations[0].getVolumeMetrics();
    const vwapDist = vwap ? ((price - vwap) / vwap * 100).toFixed(3) : '?';
    const vwapSide = vwap ? (price > vwap ? 'ABOVE ↑' : 'BELOW ↓') : '???';
    const trendEmoji = macroTrend.trend === 'BULLISH' ? '🟢' : macroTrend.trend === 'BEARISH' ? '🔴' : '⚪';

    console.log('');
    console.log(`[${ts()}] ─── MARKET SCAN (tick #${simulations[0].tickCount}) ───────────────────────────`);
    console.log(`         Price:    $${price.toFixed(2)}  |  Spread: $${spread.toFixed(2)}`);
    console.log(`         VWAP:     $${vwap ? vwap.toFixed(2) : 'N/A'}  (${vwapDist}% ${vwapSide})`);
    console.log(`         CVD 60s:  ${cvd >= 0 ? '+' : ''}${cvd.toFixed(2)} BTC  |  Spike 5s: ${spike >= 0 ? '+' : ''}${spike.toFixed(2)} (${volume.toFixed(1)} vol)`);
    console.log(`         Volume:   Buy ${buyVolume.toFixed(2)} / Sell ${sellVolume.toFixed(2)}  |  S/B: ${buyVolume > 0 ? (sellVolume / buyVolume).toFixed(2) : '0.00'}`);
    console.log(`         Macro:    ${trendEmoji} 1H: ${macroTrend.trend} | 1D: ${macroTrend.dailyTrend || 'N/A'} | Funding: ${fundingState.direction}`);

    if (indicators.sma200) {
        console.log(`         Ref:      SMA200 $${indicators.sma200.toFixed(2)} | RSI ${indicators.rsi?.toFixed(1) || 'N/A'} | ATR $${indicators.atr?.toFixed(2) || 'N/A'}`);
    }
    console.log(`         ──────────────────────────────────────────────────────────`);

    // Output status of each simulation parameter
    simulations.forEach(sim => {
        const position = sim.state.getPosition();
        if (position.size !== 0) {
            const isLong = position.size > 0;
            const side = isLong ? 'LONG' : 'SHORT';
            const uPnL = isLong ? (price - position.entryPrice) * position.size : (position.entryPrice - price) * Math.abs(position.size);
            const elapsed = sim.state.tradeOpenTime ? Date.now() - sim.state.tradeOpenTime : 0;
            const holdTime = sim.state.tradeOpenTime ? formatDuration(elapsed) : '?';
            const initStop = sim.currentCallback || sim.volMultiplier;
            let cb = initStop;
            if (elapsed > 600000) {
                cb = 0.0002;
            } else if (elapsed > 60000) {
                const ratio = (elapsed - 60000) / (600000 - 60000);
                cb = initStop - ratio * (initStop - 0.0002);
                if (cb < 0.0002) cb = 0.0002;
            }
            console.log(`         \x1b[36m[${sim.name}]\x1b[0m Pos: ${side} ${Math.abs(position.size)} BTC @ $${position.entryPrice.toFixed(2)} | uPnL: $${uPnL.toFixed(2)} | Hold: ${holdTime}`);
            console.log(`         \x1b[36m[${sim.name}]\x1b[0m Stop: $${sim.currentStopPrice?.toFixed(2) || 'N/A'} | Decay CB: ${(cb * 100).toFixed(4)}% | Cleared Fees: ${sim.state.clearedFees ? 'YES' : 'NO'}`);
        } else {
            const lCD = sim.state.isCoolingDown('LONG');
            const sCD = sim.state.isCoolingDown('SHORT');
            let cdStr = '';
            if (lCD || sCD) {
                const p = [];
                if (lCD) p.push(`LONG ❄ ${formatDuration(sim.state.cooldowns.LONG - Date.now())}`);
                if (sCD) p.push(`SHORT ❄ ${formatDuration(sim.state.cooldowns.SHORT - Date.now())}`);
                cdStr = ` | Cooldown: ${p.join(' | ')}`;
            }
            console.log(`         \x1b[36m[${sim.name}]\x1b[0m FLAT | Bal: $${sim.state.getBalance().toFixed(2)} | Trades: ${sim.tracker.trades.length} (W:${sim.tracker.getWins().length} L:${sim.tracker.getLosses().length})${cdStr}`);
        }
    });
    console.log(`         ──────────────────────────────────────────────────────────`);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

async function startMultiSim() {
    originalLog('');
    originalLog('╔════════════════════════════════════════════════════════════════╗');
    // originalLog('║     HYPERBOT V5.0.3 — MULTI-SIMULATOR RUNNER                    ║');
    originalLog('║     HYPERBOT V5.1 — MULTI-SIMULATOR RUNNER                      ║');
    originalLog('║   Testing Volatility Multipliers: (0.0004, 0.0005, 0.0006,      ║');
    originalLog('║                 0.0007, 0.0008, 0.0009, 0.0010)                 ║');
    originalLog('║           V5.0.3 Fixes: Kinetic Baseline & Wider Gates         ║');
    originalLog('╚════════════════════════════════════════════════════════════════╝');
    originalLog('');

    // Load indicators on boot
    const rawCandles = await loadAndSyncCandles('BTC', '1m', 10000);
    if (rawCandles && rawCandles.length > 0) {
        const data = formatCandleArrays(rawCandles);

        indicators.sma200 = calculateSMA(data.closes, 200);
        indicators.atr = calculateATR(data.highs, data.lows, data.closes);

        const highs60 = data.highs.slice(-60);
        const lows60 = data.lows.slice(-60);
        const closes60 = data.closes.slice(-60);
        indicators.fastAtr = calculateATR(highs60, lows60, closes60, 14);

        indicators.rsi = calculateRSI(data.closes);
        indicators.lastRefresh = Date.now();
        originalLog(`[REF] SMA200: $${indicators.sma200?.toFixed(2)} | RSI: ${indicators.rsi?.toFixed(1)} | ATR: $${indicators.atr?.toFixed(2)} | Fast ATR (1H): $${indicators.fastAtr?.toFixed(2)}`);
    }

    await refreshMacroTrend();
    await refreshFunding();
    originalLog('');

    setInterval(refreshIndicators, REFRESH_INTERVAL_MS);
    setInterval(refreshMacroTrend, REFRESH_INTERVAL_MS);

    let tickCount = 0;
    let lastScanTime = 0;

    startFeed(() => {
        tickCount++;
        if (!currentSnapshot.asks?.length || !currentSnapshot.bids?.length) return;

        const bestAsk = parseFloat(currentSnapshot.asks[0].px);
        const bestBid = parseFloat(currentSnapshot.bids[0].px);
        const midPrice = (bestAsk + bestBid) / 2;
        const spread = bestAsk - bestBid;
        const now = Date.now();

        // Run ticks for all simulations
        for (const sim of simulations) {
            currentPrefix = sim.name;
            try {
                sim.onTick(bestAsk, bestBid);
            } catch (err) {
                originalError.call(console, `Error in simulation ${sim.name}:`, err);
            }
        }
        currentPrefix = null;

        // Scans & terminal status reporting
        if (now - lastScanTime >= SCAN_INTERVAL_MS) {
            lastScanTime = now;
            try {
                printConsolidatedScan(midPrice, spread);
            } catch (err) {
                originalError.call(console, `Error writing consolidated scan log:`, err);
            }
        }

        if (tickCount >= 10000) {
            originalLog.call(console, `\n[${ts()}] Reached 10,000 ticks limit. Printing final reports...`);
            handleShutdown();
        }
    });

    originalLog(`[${ts()}] Connecting to market data feed...`);
}

if (require.main === module) {
    startMultiSim().catch(err => {
        originalError.call(console, `[FATAL]`, err);
        process.exit(1);
    });
}

module.exports = { StrategyInstance, indicators };
