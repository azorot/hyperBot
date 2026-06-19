const fs = require('fs');
const { startFeed, currentSnapshot, macroTrend, refreshMacroTrend, getVolumeMetrics, fundingState, refreshFunding, vwapState, getCVD, getCVDSpike, getSpikeDelta } = require('./feed.js');
const VirtualState = require('./state.js');
const MatchingEngine = require('./engine.js');
const { fetchHistoricalOHLC } = require('./history');
const PerformanceTracker = require('./stats.js');

// ═══════════════════════════════════════════════════════════════
//  V4.1 CONFIG — THE ORDER FLOW SCALPER (NO ORACLE)
//  VWAP + CVD replaces RSI + SMA. Rapid surgical strikes.
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

// --- Cooldown ---
const COOLDOWN_MS = 5 * 60 * 1000;     // 5 min cooldown (faster cadence for scalping)

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
let indicators = { sma200: null, atr: null, rsi: null, lastRefresh: null };

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
        indicators.rsi = calculateRSI(data.closes);
        indicators.lastRefresh = Date.now();
        console.log(`[${ts()}] [Refresh] SMA200: $${indicators.sma200?.toFixed(2)} | RSI: ${indicators.rsi?.toFixed(1)} | ATR: $${indicators.atr?.toFixed(2)}`);
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
function getScalpPhase(elapsedMs) {
    if (elapsedMs >= SCALP_PHASE_KILL) return { phase: 2, name: 'KILL_SWITCH', callback: TRAIL_CALLBACK_KILL };
    if (elapsedMs >= SCALP_PHASE_1) return { phase: 1, name: 'TIGHTENED', callback: TRAIL_CALLBACK_TIGHT };
    return { phase: 0, name: 'INITIAL', callback: TRAIL_CALLBACK_INIT };
}

function checkMicroSqueezeExit(midPrice, position) {
    if (position.size === 0 || !state.tradeOpenTime) return false;

    const isLong = position.size > 0;
    const entry = position.entryPrice;
    const elapsed = Date.now() - state.tradeOpenTime;
    const phase = getScalpPhase(elapsed);

    const profitPct = isLong ? (midPrice - entry) / entry : (entry - midPrice) / entry;

    // --- DYNAMIC BREAK-EVEN STOP ---
    if (!breakEvenTriggered && profitPct >= 0.002) { // 0.2% profit
        breakEvenTriggered = true;
        const newStop = isLong ? entry * 1.0005 : entry * 0.9995; // lock in 0.05%
        
        if (isLong && newStop > dynamicHardStop) dynamicHardStop = newStop;
        if (!isLong && newStop < dynamicHardStop) dynamicHardStop = newStop;
        
        logSignal('BREAK-EVEN STOP ACTIVATED', [
            `📈 Price in money (${(profitPct * 100).toFixed(2)}%)`,
            `Hard stop moved to $${dynamicHardStop.toFixed(2)} to guarantee profit.`
        ]);
    }

    // --- HARD STOP ---
    // dynamicHardStop is set at entry (ATR-based) and moves to break-even when in profit
    const hardHit = isLong ? midPrice <= dynamicHardStop : midPrice >= dynamicHardStop;

    if (hardHit) {
        const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
        logSignal('HARD STOP-LOSS / BREAK-EVEN', [
            `⛔ Price $${midPrice.toFixed(2)} breached stop $${dynamicHardStop.toFixed(2)}`,
            `${isLong ? 'LONG' : 'SHORT'} $${entry.toFixed(2)} | PnL: $${pnl.toFixed(2)} | Phase: ${phase.name} (${formatDuration(elapsed)})`,
            `Action: CLOSE @ market`
        ]);
        state.tradeReason = breakEvenTriggered ? 'BREAK_EVEN_STOP' : 'HARD_STOP';
        engine.executeMarketOrder(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
        
        if (!breakEvenTriggered) {
            // Apply cooldown globally to prevent instant flip/revenge trading
            state.setCooldown('LONG', COOLDOWN_MS);
            state.setCooldown('SHORT', COOLDOWN_MS);
        }
        
        resetTradeState();
        return true;
    }

    // --- TRAIL ACTIVATION ---

    if (!trailActive && profitPct >= TRAIL_ACTIVATION_PCT) {
        trailActive = true;
        trailHighWater = midPrice;
        currentCallback = phase.callback;
        currentStopPrice = isLong ? midPrice * (1 - currentCallback) : midPrice * (1 + currentCallback);

        logSignal('TRAIL ACTIVATED', [
            `📈 +${(profitPct * 100).toFixed(2)}% (threshold: ${(TRAIL_ACTIVATION_PCT * 100).toFixed(1)}%)`,
            `Phase: ${phase.name} | Callback: ${(currentCallback * 100).toFixed(2)}% | Stop: $${currentStopPrice.toFixed(2)}`
        ]);
        return false;
    }

    // --- TRAIL UPDATE ---
    if (trailActive) {
        let cb = phase.callback;
        if (fundingOverride && currentCallback !== null) cb = currentCallback;
        else currentCallback = cb;

        if (isLong) {
            if (midPrice > trailHighWater) trailHighWater = midPrice;
            const ns = trailHighWater * (1 - cb);
            if (ns > currentStopPrice) currentStopPrice = ns;
        } else {
            if (midPrice < trailHighWater) trailHighWater = midPrice;
            const ns = trailHighWater * (1 + cb);
            if (ns < currentStopPrice) currentStopPrice = ns;
        }

        const trailHit = isLong ? midPrice <= currentStopPrice : midPrice >= currentStopPrice;
        if (trailHit) {
            const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
            logSignal(`TRAIL STOP — ${phase.name}`, [
                `📉 Price $${midPrice.toFixed(2)} breached trail $${currentStopPrice.toFixed(2)}`,
                `PnL: $${pnl.toFixed(2)} | Phase: ${phase.name} (${formatDuration(elapsed)}) | CB: ${(cb * 100).toFixed(2)}%`,
                `${fundingOverride ? '⚡ Funding override active' : ''}`
            ]);
            state.tradeReason = `TRAIL_${phase.name}`;
            engine.executeMarketOrder(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
            resetTradeState();
            return true;
        }
    }

    // --- KILL SWITCH (force trail if not yet active) ---
    if (elapsed >= SCALP_PHASE_KILL && !trailActive) {
        trailActive = true;
        trailHighWater = midPrice;
        currentCallback = TRAIL_CALLBACK_KILL;
        currentStopPrice = isLong ? midPrice * (1 - TRAIL_CALLBACK_KILL) : midPrice * (1 + TRAIL_CALLBACK_KILL);
        logSignal('KILL SWITCH — FORCED TRAIL', [
            `⏰ ${formatDuration(elapsed)} without trail. Suffocating with ${(TRAIL_CALLBACK_KILL * 100).toFixed(2)}% CB`,
            `Stop: $${currentStopPrice.toFixed(2)}`
        ]);
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

    if (!spikeValid) return false;

    // We have confluence: VWAP touch + directional CVD spike
    const cvdRatio = spikeRatio;

    // Momentum confirmation: is price physically moving in our direction during the CVD spike?
    const spikeDelta = getSpikeDelta(CVD_SPIKE_WINDOW_MS);
    const priceMovingAway = direction === 'LONG' ? spikeDelta > 0 : spikeDelta < 0;
    if (!priceMovingAway) return false;

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

    logSignal(`ENTRY — VWAP ${direction === 'LONG' ? 'BOUNCE BUY' : 'REJECTION SELL'} (${direction})`, [
        `✓ VWAP: $${vwap.toFixed(2)} | Price: $${midPrice.toFixed(2)} | Dist: ${(vwapDist * 100).toFixed(3)}%`,
        `✓ CVD Spike: ${spike.toFixed(2)} BTC in ${CVD_SPIKE_WINDOW_MS / 1000}s | Ratio: ${spikeRatio.toFixed(1)}x baseline`,
        `✓ CVD 60s: ${cvd60s.toFixed(2)} | Direction: ${spike > 0 ? 'BUY PRESSURE' : 'SELL PRESSURE'}`,
        `✓ Volume in spike: ${volume.toFixed(2)} BTC`,
        `✓ Macro: 1H ${macroTrend.trend} | 1D ${macroTrend.dailyTrend || 'N/A'} | Funding: ${fundingState.direction}`,
        `✓ Size: ${tradeSize} BTC ($${(tradeSize * midPrice).toFixed(0)} USDC)`,
        `Action: OPEN ${direction} ${tradeSize} BTC @ ~$${midPrice.toFixed(2)}`,
        `Hard stop: $${hardStop.toFixed(2)} (${(effectiveStopPct * 100).toFixed(1)}%) | Trail at +${(TRAIL_ACTIVATION_PCT * 100).toFixed(1)}%`,
        `Micro-Squeeze: 0-5m ${(TRAIL_CALLBACK_INIT * 100).toFixed(2)}% → 5-10m ${(TRAIL_CALLBACK_TIGHT * 100).toFixed(2)}% → 10m+ KILL ${(TRAIL_CALLBACK_KILL * 100).toFixed(2)}%`
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
    currentStopPrice = hardStop;
    trailActive = false;
    trailHighWater = null;
    currentCallback = TRAIL_CALLBACK_INIT;
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
        const holdTime = state.tradeOpenTime ? formatDuration(Date.now() - state.tradeOpenTime) : '?';
        const elapsed = state.tradeOpenTime ? Date.now() - state.tradeOpenTime : 0;
        const phase = getScalpPhase(elapsed);

        console.log(`         Position: ${side} ${Math.abs(position.size)} BTC @ $${position.entryPrice.toFixed(2)} | uPnL: $${uPnL.toFixed(2)} | Hold: ${holdTime}`);
        console.log(`         Phase:    ${phase.name} | CB: ${(phase.callback * 100).toFixed(2)}%${fundingOverride ? ' [FUNDING]' : ''} | Stop: $${currentStopPrice?.toFixed(2) || 'N/A'} ${trailActive ? '(TRAIL)' : '(HARD)'}`);
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
    console.log('║     HYPERBOT V4.1 — THE ORDER FLOW SCALPER                    ║');
    console.log('║   VWAP + CVD | Micro-Squeeze Exits                            ║');
    console.log('║   ⚠  NO REAL ORDERS — READ-ONLY MARKET DATA  ⚠               ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log('');
    console.log(`[${ts()}] [BOOT] Balance: $${STARTING_BALANCE.toFixed(2)} USDC | Risk: ${(RISK_PER_TRADE_PCT * 100)}% | Leverage cap: ${MAX_LEVERAGE}x`);
    console.log(`[${ts()}] [BOOT] VWAP proximity: ${(VWAP_PROXIMITY_PCT * 100).toFixed(1)}% | CVD spike: ${CVD_SPIKE_THRESHOLD}x baseline`);
    console.log(`[${ts()}] [BOOT] Hard stop: ${(HARD_STOP_PCT * 100).toFixed(1)}% | Trail at +${(TRAIL_ACTIVATION_PCT * 100).toFixed(1)}%`);
    console.log(`[${ts()}] [BOOT] Micro-Squeeze: Init ${(TRAIL_CALLBACK_INIT * 100).toFixed(2)}% → Tight ${(TRAIL_CALLBACK_TIGHT * 100).toFixed(2)}% (5m) → Kill ${(TRAIL_CALLBACK_KILL * 100).toFixed(2)}% (10m)`);
    console.log(`[${ts()}] [BOOT] Cooldown: ${COOLDOWN_MS / 60000}m | Equity floor: $${EQUITY_FLOOR} | Oracle: REMOVED (v4.1)`);
    console.log(`[${ts()}] [BOOT] Logging to: ${LOG_FILE}`);
    console.log('');

    // Load reference indicators
    const data = await fetchHistoricalOHLC('BTC', '1m', 200);
    if (data && data.closes) {
        indicators.sma200 = calculateSMA(data.closes, 200);
        indicators.atr = calculateATR(data.highs, data.lows, data.closes);
        indicators.rsi = calculateRSI(data.closes);
        indicators.lastRefresh = Date.now();
        console.log(`[${ts()}] [REF] SMA200: $${indicators.sma200?.toFixed(2)} | RSI: ${indicators.rsi?.toFixed(1)} | ATR: $${indicators.atr?.toFixed(2)}`);
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
            checkVWAPEntry(midPrice, spread).catch(err => {
                console.error(`[${ts()}] [Entry Error]:`, err.message);
            });
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
        }

        // ═══ SCAN ═══
        if (now - lastScanTime >= SCAN_INTERVAL_MS) {
            lastScanTime = now;
            logMarketScan(midPrice, spread, position);
            tracker.printStatusLine(state.getBalance(), position, midPrice, macroTrend, state.tradeOpenTime);
        }
    });

    console.log(`[${ts()}] [BOOT] V4.1 Order Flow Scalper initialized (Oracle removed). Ctrl+C for final report.`);
    console.log('');
}

startBot().catch(err => {
    console.error(`[${ts()}] [FATAL]:`, err);
    process.exit(1);
});