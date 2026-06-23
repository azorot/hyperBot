const fs = require('fs');
const { startFeed, currentSnapshot, macroTrend, refreshMacroTrend, getVolumeMetrics, fundingState, refreshFunding, vwapState, getCVD, getCVDSpike, getSpikeDelta, hasMinVolume, flushTradeBuffer } = require('./feed.js');
const VirtualState = require('./state.js');
const MatchingEngine = require('./engine.js');
const { fetchHistoricalOHLC } = require('./history');
const PerformanceTracker = require('./stats.js');

// ═══════════════════════════════════════════════════════════════
//  V5.01 CONFIG — THE TIME-DECAY YIELD SCALPER
//  VWAP + CVD + Time-Decay stop + Log Decay Reversal Snap + 15m Kill Switch.
//  ATR volatility gating + Trailing Shadow Limits (Post-Only Maker exits).
//  NO REAL ORDERS. READ-ONLY MARKET DATA. PAPER TRADING ONLY.
// ═══════════════════════════════════════════════════════════════

// --- Capital & Sizing ---
const STARTING_BALANCE = 1000.0;       // USDC
const RISK_PER_TRADE_PCT = 0.02;       // 2% of equity per trade
const MAX_LEVERAGE = 3;                // Hard cap
const EQUITY_FLOOR = 80.0;             // Kill switch

// --- VWAP Entry Logic ---
const VWAP_PROXIMITY_PCT = 0.001;      // Price must be within 0.1% of VWAP for a "touch"
const CVD_SPIKE_WINDOW_MS = 5000;      // 5s window for CVD spike detection
const CVD_SPIKE_THRESHOLD = 2.0;       // Spike must be 2x the average 60s CVD rate

// --- Micro-Squeeze Exit ---
const HARD_STOP_PCT = 0.005;           // 0.5% hard stop (tighter for scalping)
const TRAIL_ACTIVATION_PCT = 0.005;    // Trail activates at 0.5% profit
const TRAIL_CALLBACK_INIT = 0.0015;    // Initial trail callback: 0.15%
const TRAIL_CALLBACK_TIGHT = 0.0008;   // Tightened callback after 5min
const TRAIL_CALLBACK_KILL = 0.0003;    // Kill callback after 10min
const SCALP_PHASE_1 = 5 * 60000;       // 5 min — tighten
const SCALP_PHASE_KILL = 10 * 60000;   // 10 min — kill switch

// --- Cooldown & Volume ---
const COOLDOWN_MS = 5 * 60 * 1000;     // 5 min cooldown (faster cadence for scalping)
const MIN_VOLUME_THRESHOLD = 10.0;     // 10 BTC minimum volume in 60s window

// --- Funding ---
const FUNDING_CHECK_MINUTE = 50;
const TRAIL_CB_FUNDING_BAD = 0.0005;

// --- Intervals ---
const SCAN_INTERVAL_MS = 15 * 1000;    // Faster scans for scalping
const REPORT_INTERVAL_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════
//  SYSTEM STATE
// ═══════════════════════════════════════════════════════════════
const state = new VirtualState(STARTING_BALANCE);
const engine = new MatchingEngine(state);
const tracker = new PerformanceTracker(STARTING_BALANCE);

let tickCount = 0;
let lastScanTime = 0;
let lastTradeCount = 0;
let lastSweepDay = new Date().getUTCDate();
let lastLiqWarnTime = 0;
let lastFundingCheck = 0;

// Trail state
let currentStopPrice = null;
let trailActive = false;
let trailHighWater = null;
let currentCallback = null;
let fundingOverride = false;
let dynamicHardStop = null;
let breakEvenTriggered = false;

// CVD baseline for spike detection
let cvdBaseline = { avgRate: 0, lastCalc: 0 };

// Indicators (kept for SMA reference in logging, but NOT used for entry)
let indicators = { sma200: null, atr: null, fastAtr: null, rsi: null, lastRefresh: null };

// Log
const LOG_FILE = `sim_log_${new Date().toISOString().slice(0, 10)}.txt`;
const originalLog = console.log;
const originalError = console.error;
console.log = function (...args) {
    const line = args.join(' ');
    originalLog.apply(console, args);
    fs.appendFileSync(LOG_FILE, line + '\n');
};
console.error = function (...args) {
    const line = args.join(' ');
    originalError.apply(console, args);
    fs.appendFileSync(LOG_FILE, '[ERROR] ' + line + '\n');
};

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════
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
//  POSITION SIZING — USDC with Leverage Cap
// ═══════════════════════════════════════════════════════════════
function calculatePositionSize(equity, entryPrice, stopDistancePct) {
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
        console.log(`[Risk] ⚠ Fees $${fees.toFixed(2)} = ${((fees / riskUSDC) * 100).toFixed(0)}% of risk $${riskUSDC.toFixed(2)}`);
    }

    const rounded = Math.floor(sizeBTC * 1000) / 1000;
    if (rounded < 0.001) return 0;

    const notional = rounded * entryPrice;
    console.log(`[Risk] Equity: $${equity.toFixed(2)} | Risk: $${riskUSDC.toFixed(2)} | Size: ${rounded} BTC ($${notional.toFixed(0)}) | Lev: ${(notional / equity).toFixed(1)}x`);
    return rounded;
}

// ═══════════════════════════════════════════════════════════════
//  INDICATOR REFRESH (kept for reference logging only)
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
        const data = await fetchHistoricalOHLC('BTC', '1m', 200);
        if (!data || !data.closes) return;
        indicators.sma200 = calculateSMA(data.closes, 200);
        indicators.atr = calculateATR(data.highs, data.lows, data.closes);
        
        // Fast ATR on last hour of volatility (60 1m candles)
        const highs60 = data.highs.slice(-60);
        const lows60 = data.lows.slice(-60);
        const closes60 = data.closes.slice(-60);
        indicators.fastAtr = calculateATR(highs60, lows60, closes60, 14);
        
        indicators.rsi = calculateRSI(data.closes);
        indicators.lastRefresh = Date.now();
        console.log(`[${ts()}] [Refresh] SMA200: $${indicators.sma200?.toFixed(2)} | RSI: ${indicators.rsi?.toFixed(1)} | ATR: $${indicators.atr?.toFixed(2)} | Fast ATR (1H): $${indicators.fastAtr?.toFixed(2)}`);
    } catch (err) { console.error(`[${ts()}] [Refresh] Error:`, err.message); }
}

// ═══════════════════════════════════════════════════════════════
//  CVD BASELINE — Rolling average for spike detection
// ═══════════════════════════════════════════════════════════════
function updateCVDBaseline() {
    const now = Date.now();
    if (now - cvdBaseline.lastCalc < 10000) return; // Update every 10s

    const { buyVolume, sellVolume } = getVolumeMetrics();
    const totalVol = buyVolume + sellVolume;
    // Average delta rate per second over the 60s window
    cvdBaseline.avgRate = totalVol > 0 ? Math.abs(buyVolume - sellVolume) / 60 : 0;
    cvdBaseline.lastCalc = now;
}

// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  MICRO-SQUEEZE EXIT ENGINE
// ═══════════════════════════════════════════════════════════════

function checkMicroSqueezeExit(midPrice, position) {
    if (position.size === 0 || !state.tradeOpenTime) return false;

    const isLong = position.size > 0;
    const side = isLong ? 'LONG' : 'SHORT';
    const entry = position.entryPrice;
    const elapsed = Date.now() - state.tradeOpenTime;

    // --- 15-MINUTE KILL SWITCH ---
    if (elapsed >= 900000) {
        const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
        logSignal('15-MINUTE KILL SWITCH', [
            `⏰ Time limit reached (15m). Force closing position via Post-Only Limit Order.`,
            `${side} entry: $${entry.toFixed(2)} | PnL: $${pnl.toFixed(2)}`,
            `Action: POST LIMIT EXIT @ spread`
        ]);
        state.tradeReason = 'TIMEOUT_15M';
        engine.postLimitExit(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
        return true;
    }

    // --- HARD STOP ---
    // dynamicHardStop is set at entry (ATR-based)
    const hardHit = isLong ? midPrice <= dynamicHardStop : midPrice >= dynamicHardStop;
    if (hardHit) {
        const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
        logSignal('HARD STOP-LOSS', [
            `⛔ Price $${midPrice.toFixed(2)} breached hard stop $${dynamicHardStop.toFixed(2)}`,
            `${side} entry: $${entry.toFixed(2)} | PnL: $${pnl.toFixed(2)} | Elapsed: ${formatDuration(elapsed)}`,
            `Action: CLOSE @ market (Taker)`
        ]);
        state.tradeReason = 'HARD_STOP';
        engine.executeMarketOrder(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
        
        // Apply cooldown globally to prevent instant flip/revenge trading
        state.setCooldown('LONG', COOLDOWN_MS);
        state.setCooldown('SHORT', COOLDOWN_MS);
        resetTradeState();
        return true;
    }

    // --- TIME-DECAY TRAILING STOP ---
    if (trailActive) {
        // Reversal Detection (Momentum Snap)
        if (!state.reversalSnapped) {
            const { spike } = getCVDSpike(CVD_SPIKE_WINDOW_MS);
            const spikePerSec = Math.abs(spike) / (CVD_SPIKE_WINDOW_MS / 1000);
            const spikeRatio = cvdBaseline.avgRate > 0 ? spikePerSec / cvdBaseline.avgRate : 0;
            const isReversalSpike = isLong ? (spike < 0) : (spike > 0);

            if (isReversalSpike && spikeRatio >= 1.5 && Math.abs(spike) >= 1.0) {
                state.reversalSnapped = true;
                state.snapTime = Date.now();
                logSignal('MOMENTUM SNAP ACTIVATED', [
                    `⚡ Sudden adverse volume detected! Spike: ${spike.toFixed(2)} BTC (Ratio: ${spikeRatio.toFixed(1)}x baseline)`,
                    `Abandons linear time-decay. Snapping trailing stop tighter using logarithmic decay.`
                ]);
            }
        }

        // Calculate callback rate
        const initStop = currentCallback || 0.0015;
        let cb = initStop;
        if (state.reversalSnapped) {
            const timeSinceSnap = Date.now() - state.snapTime;
            cb = initStop / (1 + Math.log(1 + timeSinceSnap / 1000));
            if (cb < 0.0002) cb = 0.0002;
        } else {
            // Linear decay
            if (elapsed > 600000) {
                cb = 0.0002;
            } else if (elapsed > 60000) {
                const ratio = (elapsed - 60000) / (600000 - 60000);
                cb = initStop - ratio * (initStop - 0.0002);
                if (cb < 0.0002) cb = 0.0002;
            }
        }

        // Taker fee break-even check
        const clearsFees = engine.clearsTakerFees(entry, midPrice, side);
        if (clearsFees && !state.clearedFees) {
            state.clearedFees = true;
            console.log(`[${ts()}] [Consider] Price action has cleared taker fee threshold ($${engine.getBreakEvenPrice(entry, side).toFixed(2)}). Trailing stop is now active and moving.`);
        }

        // Only allowed to move trailing stop if we have cleared taker fees
        if (state.clearedFees) {
            if (isLong) {
                if (midPrice > trailHighWater) trailHighWater = midPrice;
                const ns = trailHighWater * (1 - cb);
                if (ns > currentStopPrice) currentStopPrice = ns;
            } else {
                if (midPrice < trailHighWater) trailHighWater = midPrice;
                const ns = trailHighWater * (1 + cb);
                if (ns < currentStopPrice) currentStopPrice = ns;
            }
        }

        const trailHit = isLong ? midPrice <= currentStopPrice : midPrice >= currentStopPrice;
        if (trailHit) {
            const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
            logSignal('TRAIL STOP EXIT', [
                `📉 Price $${midPrice.toFixed(2)} breached trail $${currentStopPrice.toFixed(2)}`,
                `PnL: $${pnl.toFixed(2)} | Hold: ${formatDuration(elapsed)} | Callback: ${(cb * 100).toFixed(4)}%`,
                `Snapped: ${state.reversalSnapped ? 'YES (Log Decay)' : 'NO (Linear)'} | Cleared Fees: ${state.clearedFees ? 'YES' : 'NO'}`
            ]);
            state.tradeReason = state.clearedFees ? 'TRAIL_EXIT' : 'FEE_THRESHOLD_FAILURE';
            engine.postLimitExit(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
            return true;
        }
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════
//  FUNDING INTERCEPT
// ═══════════════════════════════════════════════════════════════
async function checkFundingIntercept(position) {
    if (position.size === 0) return;
    const now = new Date();
    const minute = now.getUTCMinutes();
    if (minute < FUNDING_CHECK_MINUTE || minute > 55) return;
    if (now.getTime() - lastFundingCheck < 5 * 60000) return;
    lastFundingCheck = now.getTime();

    await refreshFunding();
    if (fundingState.rate === null || fundingState.direction === 'UNKNOWN') return;

    const isLong = position.size > 0;
    const dir = fundingState.direction;
    console.log(`[${ts()}] [FUNDING] T-${60 - minute}min | Rate: ${(fundingState.rate * 100).toFixed(4)}% | ${dir}`);

    const favorableForLong = dir === 'NEGATIVE';
    const favorableForShort = dir === 'POSITIVE';

    if ((isLong && !favorableForLong) || (!isLong && !favorableForShort)) {
        console.log(`[${ts()}] [FUNDING] ⚡ Adverse funding. Tightening trail to ${(TRAIL_CB_FUNDING_BAD * 100).toFixed(2)}%`);
        if (trailActive) { currentCallback = TRAIL_CB_FUNDING_BAD; fundingOverride = true; }
    } else {
        console.log(`[${ts()}] [FUNDING] 💰 Favorable funding. Holding.`);
        fundingOverride = false;
    }
}

// ═══════════════════════════════════════════════════════════════
//  ENTRY LOGIC — VWAP + CVD Order Flow
// ═══════════════════════════════════════════════════════════════
async function checkVWAPEntry(midPrice, spread) {
    const vwap = vwapState.vwap;
    if (!vwap) return false;

    const vwapDist = (midPrice - vwap) / vwap;
    const vwapTouching = Math.abs(vwapDist) <= VWAP_PROXIMITY_PCT;
    if (!vwapTouching) return false;

    // Determine direction: above VWAP = accumulating (long), below = distributing (short)
    const priceAboveVWAP = midPrice > vwap;
    const direction = priceAboveVWAP ? 'LONG' : 'SHORT';

    // Cooldown check
    if (state.isCoolingDown(direction)) return false;

    // --- ATR Volatility Hurdle ---
    const currentATR = indicators.fastAtr || indicators.atr;
    if (!currentATR) return false;
    const atrHurdle = midPrice * 0.0015;
    if (currentATR <= atrHurdle) {
        console.log(`[${ts()}] [Consider] Touched VWAP, but volatility is too low. ATR $${currentATR.toFixed(2)} <= Hurdle $${atrHurdle.toFixed(2)}. Stand down.`);
        return false;
    }

    console.log(`[${ts()}] [Consider] Touched VWAP. Volatility is sufficient ($${currentATR.toFixed(2)} > $${atrHurdle.toFixed(2)}). Checking order flow...`);

    // CVD spike detection
    const { spike, volume } = getCVDSpike(CVD_SPIKE_WINDOW_MS);
    const cvd60s = getCVD();

    // Calculate spike intensity relative to baseline
    const spikePerSec = Math.abs(spike) / (CVD_SPIKE_WINDOW_MS / 1000);
    const spikeRatio = cvdBaseline.avgRate > 0 ? spikePerSec / cvdBaseline.avgRate : 0;

    // Validate spike is in the right direction and meets threshold
    const spikeValid = direction === 'LONG'
        ? spike > 0 && spikeRatio >= CVD_SPIKE_THRESHOLD
        : spike < 0 && spikeRatio >= CVD_SPIKE_THRESHOLD;

    if (!spikeValid) {
        if (Math.abs(spikeRatio) >= 1.0) {
            console.log(`[${ts()}] [Consider] Order flow spike detected, but invalid setup. Ratio: ${spikeRatio.toFixed(1)}x, Direction matches: ${spikeValid}. Stand down.`);
        }
        return false;
    }

    // We have confluence: VWAP touch + directional CVD spike
    const cvdRatio = spikeRatio;

    // Momentum confirmation: is price physically moving in our direction during the CVD spike?
    const spikeDelta = getSpikeDelta(CVD_SPIKE_WINDOW_MS);
    const priceMovingAway = direction === 'LONG' ? spikeDelta > 0 : spikeDelta < 0;
    if (!priceMovingAway) {
        console.log(`[${ts()}] [Consider] CVD spiked in direction (${direction}) but price momentum delta is adverse ($${spikeDelta.toFixed(2)}). Risking liquidity traps. Stand down.`);
        return false;
    }

    console.log(`[${ts()}] [Consider] CONFLUENCE ACHIEVED: VWAP proximity + CVD Spike (${spikeRatio.toFixed(1)}x) + Price Momentum Confirmation ($${spikeDelta.toFixed(2)}). Sizing position...`);

    // Calculate position size (Dynamic ATR-based hard stop)
    const effectiveStopPct = indicators.atr ? (1.5 * indicators.atr) / midPrice : HARD_STOP_PCT;
    const tradeSize = calculatePositionSize(state.getBalance(), midPrice, effectiveStopPct);
    if (tradeSize === 0) {
        console.log(`[${ts()}] [RISK] Size too small — skipping.`);
        return false;
    }

    const hardStop = direction === 'LONG'
        ? midPrice * (1 - effectiveStopPct)
        : midPrice * (1 + effectiveStopPct);

    dynamicHardStop = hardStop;

    // Calculate initial stop adjustment based on fast ATR
    const fastAtr = indicators.fastAtr || indicators.atr || 30.0;
    const relATR = fastAtr / midPrice;
    const baselineRelATR = 0.0005; // 0.05%
    let adjustedInitialStop = 0.0015 * (relATR / baselineRelATR);
    // Clamp between 0.02% (0.0002) and 0.50% (0.0050)
    adjustedInitialStop = Math.max(0.0002, Math.min(0.0050, adjustedInitialStop));

    logSignal(`ENTRY — VWAP ${direction === 'LONG' ? 'BOUNCE BUY' : 'REJECTION SELL'} (${direction})`, [
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

    state.tradeReason = JSON.stringify({
        type: `VWAP_${direction === 'LONG' ? 'BOUNCE' : 'REJECTION'}`,
        confluence: { vwapDist, cvdSpike: spike, cvdRatio: spikeRatio, spread, volume }
    });

    if (direction === 'LONG') {
        engine.executeMarketOrder('buy', tradeSize, currentSnapshot);
    } else {
        engine.executeMarketOrder('sell', tradeSize, currentSnapshot);
    }

    state.targetExit = null; // No SMA target in V4 — purely trail-managed
    trailActive = true;      // Active immediately
    trailHighWater = midPrice;
    currentCallback = adjustedInitialStop;
    currentStopPrice = direction === 'LONG'
        ? midPrice * (1 - adjustedInitialStop)
        : midPrice * (1 + adjustedInitialStop);
    fundingOverride = false;
    return true;
}

// ═══════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════
function logSignal(type, details) {
    console.log('');
    console.log(`[${ts()}] ┌─── ${type} ──────────────────────────────────────────`);
    details.forEach(line => { if (line) console.log(`[${ts()}] │ ${line}`); });
    console.log(`[${ts()}] └──────────────────────────────────────────────────────────`);
}

function logMarketScan(price, spread, position) {
    const vwap = vwapState.vwap;
    const cvd = getCVD();
    const { spike, volume } = getCVDSpike(CVD_SPIKE_WINDOW_MS);
    const { buyVolume, sellVolume } = getVolumeMetrics();
    const vwapDist = vwap ? ((price - vwap) / vwap * 100).toFixed(3) : '?';
    const vwapSide = vwap ? (price > vwap ? 'ABOVE ↑' : 'BELOW ↓') : '???';
    const trendEmoji = macroTrend.trend === 'BULLISH' ? '🟢' : macroTrend.trend === 'BEARISH' ? '🔴' : '⚪';

    console.log('');
    console.log(`[${ts()}] ─── MARKET SCAN (tick #${tickCount}) ───────────────────────────`);
    console.log(`         Price:    $${price.toFixed(2)}  |  Spread: $${spread.toFixed(2)}`);
    console.log(`         VWAP:     $${vwap ? vwap.toFixed(2) : 'N/A'}  (${vwapDist}% ${vwapSide})`);
    console.log(`         CVD 60s:  ${cvd >= 0 ? '+' : ''}${cvd.toFixed(2)} BTC  |  Spike 5s: ${spike >= 0 ? '+' : ''}${spike.toFixed(2)} (${volume.toFixed(1)} vol)`);
    console.log(`         Volume:   Buy ${buyVolume.toFixed(2)} / Sell ${sellVolume.toFixed(2)}  |  S/B: ${buyVolume > 0 ? (sellVolume / buyVolume).toFixed(2) : '0.00'}`);
    console.log(`         Macro:    ${trendEmoji} 1H: ${macroTrend.trend} | 1D: ${macroTrend.dailyTrend || 'N/A'} | Funding: ${fundingState.direction}`);

    if (indicators.sma200) {
        console.log(`         Ref:      SMA200 $${indicators.sma200.toFixed(2)} | RSI ${indicators.rsi?.toFixed(1) || 'N/A'} | ATR $${indicators.atr?.toFixed(2) || 'N/A'}`);
    }

    if (position.size !== 0) {
        const isLong = position.size > 0;
        const side = isLong ? 'LONG' : 'SHORT';
        const uPnL = isLong ? (price - position.entryPrice) * position.size : (position.entryPrice - price) * Math.abs(position.size);
        const elapsed = state.tradeOpenTime ? Date.now() - state.tradeOpenTime : 0;
        const holdTime = state.tradeOpenTime ? formatDuration(elapsed) : '?';
        const initStop = currentCallback || 0.0015;
        let cb = initStop;
        if (elapsed > 600000) {
            cb = 0.0002;
        } else if (elapsed > 60000) {
            const ratio = (elapsed - 60000) / (600000 - 60000);
            cb = initStop - ratio * (initStop - 0.0002);
            if (cb < 0.0002) cb = 0.0002;
        }

        console.log(`         Position: ${side} ${Math.abs(position.size)} BTC @ $${position.entryPrice.toFixed(2)} | uPnL: $${uPnL.toFixed(2)} | Hold: ${holdTime}`);
        console.log(`         Decay CB: ${(cb * 100).toFixed(4)}% | Cleared Fees: ${state.clearedFees ? 'YES' : 'NO'} | Stop: $${currentStopPrice?.toFixed(2) || 'N/A'}`);
    } else {
        console.log(`         Position: FLAT`);
        const lCD = state.isCoolingDown('LONG');
        const sCD = state.isCoolingDown('SHORT');
        if (lCD || sCD) {
            const p = [];
            if (lCD) p.push(`LONG ❄ ${formatDuration(state.cooldowns.LONG - Date.now())}`);
            if (sCD) p.push(`SHORT ❄ ${formatDuration(state.cooldowns.SHORT - Date.now())}`);
            console.log(`         Cooldown: ${p.join(' | ')}`);
        }
    }

    console.log(`         Balance:  $${state.getBalance().toFixed(2)}  |  Trades: ${tracker.trades.length} (W:${tracker.getWins().length} L:${tracker.getLosses().length})`);
    console.log(`         ──────────────────────────────────────────────────────────`);
}

function resetTradeState() {
    state.targetExit = null;
    currentStopPrice = null;
    trailActive = false;
    trailHighWater = null;
    currentCallback = null;
    fundingOverride = false;
    dynamicHardStop = null;
    breakEvenTriggered = false;
}

// ═══════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════
function handleShutdown() {
    console.log('');
    console.log(`[${ts()}] ⚠ Shutdown signal received.`);
    let price = 0;
    if (currentSnapshot.asks?.length > 0) price = parseFloat(currentSnapshot.asks[0].px);
    tracker.printReport(state.getBalance(), tickCount, state.getPosition(), price, true);
    console.log(`[${ts()}] Log: ${LOG_FILE} | Ledger: trade_ledger.jsonl`);
    process.exit(0);
}
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// ═══════════════════════════════════════════════════════════════
//  MAIN BOOT
// ═══════════════════════════════════════════════════════════════
async function startBot() {
    console.log('');
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║     HYPERBOT V5.01 — THE TIME-DECAY YIELD SCALPER              ║');
    console.log('║   VWAP + CVD | Volatility Gating, Maker Exits & Log Decay      ║');
    console.log('║   ⚠  NO REAL ORDERS — READ-ONLY MARKET DATA  ⚠               ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`[${ts()}] [BOOT] Balance: $${STARTING_BALANCE.toFixed(2)} USDC | Risk: ${(RISK_PER_TRADE_PCT * 100)}% | Leverage cap: ${MAX_LEVERAGE}x`);
    console.log(`[${ts()}] [BOOT] VWAP proximity: ${(VWAP_PROXIMITY_PCT * 100).toFixed(1)}% | CVD spike: ${CVD_SPIKE_THRESHOLD}x baseline`);
    console.log(`[${ts()}] [BOOT] Volume filter: Min ${MIN_VOLUME_THRESHOLD} BTC / 60s | Volatility gate: ATR > 0.15% of Entry`);
    console.log(`[${ts()}] [BOOT] Trailing Exits: Trailing Shadow Limits (Post-Only Maker structure rebate captured)`);
    console.log(`[${ts()}] [BOOT] Momentum Snaps: Steep logarithmic decay curve triggered on adverse volume`);
    console.log(`[${ts()}] [BOOT] Time limit: 15-minute Hard Kill Switch | Fee-adjusted break-even: 0.035% Taker fee`);
    console.log(`[${ts()}] [BOOT] Cooldown: ${COOLDOWN_MS / 60000}m | Equity floor: $${EQUITY_FLOOR}`);
    console.log(`[${ts()}] [BOOT] Logging to: ${LOG_FILE}`);
    console.log('');

    // Load reference indicators
    const data = await fetchHistoricalOHLC('BTC', '1m', 200);
    if (data && data.closes) {
        indicators.sma200 = calculateSMA(data.closes, 200);
        indicators.atr = calculateATR(data.highs, data.lows, data.closes);
        
        const highs60 = data.highs.slice(-60);
        const lows60 = data.lows.slice(-60);
        const closes60 = data.closes.slice(-60);
        indicators.fastAtr = calculateATR(highs60, lows60, closes60, 14);
        
        indicators.rsi = calculateRSI(data.closes);
        indicators.lastRefresh = Date.now();
        console.log(`[${ts()}] [REF] SMA200: $${indicators.sma200?.toFixed(2)} | RSI: ${indicators.rsi?.toFixed(1)} | ATR: $${indicators.atr?.toFixed(2)} | Fast ATR (1H): $${indicators.fastAtr?.toFixed(2)}`);
    }

    await refreshMacroTrend();
    await refreshFunding();
    console.log('');

    setInterval(refreshIndicators, REFRESH_INTERVAL_MS);
    setInterval(refreshMacroTrend, REFRESH_INTERVAL_MS);
    setInterval(() => {
        let p = 0;
        if (currentSnapshot.asks?.length > 0) p = parseFloat(currentSnapshot.asks[0].px);
        tracker.printReport(state.getBalance(), tickCount, state.getPosition(), p);
    }, REPORT_INTERVAL_MS);

    console.log(`[${ts()}] [BOOT] Connecting to market data feed...`);

    startFeed(() => {
        tickCount++;
        const now = Date.now();
        if (!currentSnapshot.asks?.length || !currentSnapshot.bids?.length) return;

        // Cold storage sweep
        const day = new Date(now).getUTCDate();
        if (day !== lastSweepDay) {
            lastSweepDay = day;
            const surplus = state.getBalance() - STARTING_BALANCE;
            if (surplus > 0) {
                logSignal('COLD STORAGE SWEEP', [`🧹 Withdrawing $${surplus.toFixed(2)} surplus`]);
                state.balance -= surplus;
            }
        }

        const bestAsk = parseFloat(currentSnapshot.asks[0].px);
        const bestBid = parseFloat(currentSnapshot.bids[0].px);
        const midPrice = (bestAsk + bestBid) / 2;
        const spread = bestAsk - bestBid;
        const position = state.getPosition();

        // Update CVD baseline
        updateCVDBaseline();

        // ═══ ACTIVE LIMIT EXIT ORDER CHECK ═══
        if (engine.activeLimitOrder) {
            const filled = engine.updateLimitExit(currentSnapshot);
            if (filled) {
                resetTradeState();
            }
            return; // Skip further checks while limit order is executing
        }

        // ═══ CIRCUIT BREAKER ═══
        if (state.isHalted()) {
            if (state.killed) {
                logSignal('⛔ EQUITY FLOOR — EMERGENCY SHUTDOWN', [`Balance: $${state.getBalance().toFixed(2)} <= $${EQUITY_FLOOR}`]);
                if (position.size !== 0) {
                    state.tradeReason = 'EQUITY_FLOOR';
                    engine.executeMarketOrder(position.size > 0 ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
                    resetTradeState();
                }
                handleShutdown();
                return;
            }
            if (now - lastScanTime >= SCAN_INTERVAL_MS) {
                console.log(`[${ts()}] [HALTED] Circuit breaker. Trading suspended.`);
                lastScanTime = now;
            }
            return;
        }

        // ═══ EXIT ═══
        if (position.size !== 0) {
            // Liquidation watchdog
            const notional = Math.abs(position.size) * midPrice;
            const maint = notional * 0.01;
            const uPnL = position.size > 0 ? (midPrice - position.entryPrice) * position.size : (position.entryPrice - midPrice) * Math.abs(position.size);
            const eq = state.getBalance() + uPnL;
            if (Math.max(0, eq - maint) / maint < 0.20 && (now - lastLiqWarnTime > 60000)) {
                console.log(`[${ts()}] [WARNING] 🚨 LIQUIDATION WATCHDOG`);
                lastLiqWarnTime = now;
            }

            checkFundingIntercept(position).catch(() => { });
            if (checkMicroSqueezeExit(midPrice, position)) return;
        }

        // ═══ ENTRY ═══
        if (position.size === 0) {
            if (hasMinVolume(MIN_VOLUME_THRESHOLD)) {
                checkVWAPEntry(midPrice, spread).catch(err => {
                    console.error(`[${ts()}] [Entry Error]:`, err.message);
                });
            }
        }

        // ═══ TRADE RECORDING ═══
        if (state.completedTrades.length > lastTradeCount) {
            for (let i = lastTradeCount; i < state.completedTrades.length; i++) {
                const t = state.completedTrades[i];
                tracker.recordTrade(t);
                let entryType = 'N/A';
                try { entryType = JSON.parse(t.entryReason).type; } catch { entryType = t.entryReason || 'N/A'; }

                logSignal('TRADE CLOSED', [
                    `${t.side} ${t.size} BTC | ${entryType}`,
                    `$${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${t.exitReason || 'N/A'} | ${t.durationMs ? formatDuration(t.durationMs) : '?'}`,
                    `Gross: $${t.grossPnl.toFixed(2)} | Fees: $${t.totalFees.toFixed(4)} | Net: $${t.pnl.toFixed(2)} ${t.pnl >= 0 ? '✅' : '❌'}`,
                    `Balance: $${t.balanceAfter.toFixed(2)} | W:${tracker.getWins().length} L:${tracker.getLosses().length} (${(tracker.getWinRate() * 100).toFixed(0)}%)`
                ]);
            }
            lastTradeCount = state.completedTrades.length;
            // Force reset/refresh indicators immediately post-trade
            refreshIndicators().catch(err => {
                console.error(`[Refresh Error Post-Trade]:`, err.message);
            });
        }

        // ═══ SCAN ═══
        if (now - lastScanTime >= SCAN_INTERVAL_MS) {
            lastScanTime = now;
            logMarketScan(midPrice, spread, position);
            tracker.printStatusLine(state.getBalance(), position, midPrice, macroTrend, state.tradeOpenTime);
        }
    });

    console.log(`[${ts()}] [BOOT] V5.01 Time-Decay Yield Scalper initialized. Ctrl+C for final report.`);
    console.log('');
}

startBot().catch(err => {
    console.error(`[${ts()}] [FATAL]:`, err);
    process.exit(1);
});