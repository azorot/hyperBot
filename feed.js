const WebSocket = require('ws');
const { fetchHourlyCandles } = require('./history');

const currentSnapshot = {
    bids: [],
    asks: [],
    lastUpdate: null
};

const macroTrend = {
    hourlyClose: null,
    hourlySMA: null,
    trend: 'UNKNOWN', // 'BULLISH', 'BEARISH', or 'UNKNOWN'
    dailyTrend: 'UNKNOWN', // 'BULLISH', 'BEARISH', or 'UNKNOWN'
    lastUpdate: null
};

let tradeBuffer = [];
const WINDOW_DURATION_MS = 60 * 1000; // 60-second rolling window

const vwapState = {
    cumulativePV: 0,    // sum of price * volume
    cumulativeVol: 0,   // sum of volume
    vwap: null,
    resetDay: new Date().getUTCDate()
};

/**
 * Fetches 1H and 1D candles to determine macro trend direction.
 * Bullish = close above SMA200.
 * Call this on boot and periodically (every 5 min) to keep fresh.
 */
async function refreshMacroTrend() {
    try {
        const hourlyData = await fetchHourlyCandles('BTC', 200);
        if (!hourlyData || !hourlyData.closes || hourlyData.closes.length === 0) {
            console.log('[Macro] Failed to refresh hourly trend — no data.');
            return;
        }

        const closes = hourlyData.closes;
        macroTrend.hourlyClose = closes[closes.length - 1];

        // Calculate hourly SMA50 (or as many periods as available)
        const period = Math.min(50, closes.length);
        const slice = closes.slice(-period);
        macroTrend.hourlySMA = slice.reduce((a, b) => a + b, 0) / period;

        const prevTrend = macroTrend.trend;
        macroTrend.trend = macroTrend.hourlyClose > macroTrend.hourlySMA ? 'BULLISH' : 'BEARISH';
        
        // Fetch Daily for hedge logic
        try {
            const { fetchHistoricalOHLC } = require('./history');
            const dailyData = await fetchHistoricalOHLC('BTC', '1d', 200);
            if (dailyData && dailyData.closes && dailyData.closes.length > 0) {
                const closes1d = dailyData.closes;
                const p = Math.min(200, closes1d.length);
                const sma1d = closes1d.slice(-p).reduce((a, b) => a + b, 0) / p;
                macroTrend.dailyTrend = closes1d[closes1d.length - 1] > sma1d ? 'BULLISH' : 'BEARISH';
            }
        } catch (e) {
            console.error('[Macro] Error fetching daily trend:', e.message);
        }

        macroTrend.lastUpdate = Date.now();

        const emoji = macroTrend.trend === 'BULLISH' ? '🟢' : '🔴';
        const changed = prevTrend !== macroTrend.trend && prevTrend !== 'UNKNOWN' ? ' ⚠ TREND CHANGE!' : '';
        console.log(`[Macro] ${emoji} 1H: ${macroTrend.trend} (Close: $${macroTrend.hourlyClose.toFixed(2)} | SMA: $${macroTrend.hourlySMA.toFixed(2)}) | 1D: ${macroTrend.dailyTrend}${changed}`);
    } catch (err) {
        console.error('[Macro] Error refreshing trend:', err.message);
    }
}

/**
 * Connects to the Hyperliquid L1 WebSocket for READ-ONLY market data.
 * No orders are placed — this is a data feed only.
 *
 * @param {Function} onTick - Called on EVERY l2Book update after initial sync.
 */
function startFeed(onTick) {
    let synced = false;
    let reconnectDelay = 1000;
    const MAX_DELAY = 30000;
    let watchdog;

    function resetWatchdog(ws) {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
            console.error('[Pipeline] Watchdog timeout: No data for 15s. Terminating connection...');
            ws.terminate(); // forcefully close, triggering on('close')
        }, 15000);
    }

    function connect() {
        const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

        ws.on('open', () => {
            console.log('[Pipeline] Connected to Hyperliquid L1 (READ-ONLY). Subscribing to streams...');
            reconnectDelay = 1000;
            resetWatchdog(ws);

            ws.send(JSON.stringify({
                method: "subscribe",
                subscription: { type: "l2Book", coin: "BTC" }
            }));

            ws.send(JSON.stringify({
                method: "subscribe",
                subscription: { type: "trades", coin: "BTC" }
            }));
        });

        ws.on('message', (data) => {
            resetWatchdog(ws);
            const response = JSON.parse(data);
            const currentTime = Date.now();

            if (response.channel === 'l2Book' && response.data) {
                currentSnapshot.bids = response.data.levels[0];
                currentSnapshot.asks = response.data.levels[1];
                currentSnapshot.lastUpdate = currentTime;

                if (!synced && currentSnapshot.bids.length > 0) {
                    synced = true;
                    console.log('[Pipeline] Initial book snapshot received. Feed is LIVE.');
                }

                if (synced) {
                    onTick();
                }
            }

            if (response.channel === 'trades' && response.data) {
                const nowDay = new Date().getUTCDate();
                if (nowDay !== vwapState.resetDay) {
                    vwapState.cumulativePV = 0;
                    vwapState.cumulativeVol = 0;
                    vwapState.vwap = null;
                    vwapState.resetDay = nowDay;
                    console.log('[VWAP] Daily reset.');
                }

                response.data.forEach(trade => {
                    const px = parseFloat(trade.px);
                    const sz = parseFloat(trade.sz);

                    tradeBuffer.push({
                        size: sz,
                        side: trade.side,
                        time: trade.time,
                        price: px
                    });

                    vwapState.cumulativePV += px * sz;
                    vwapState.cumulativeVol += sz;
                    vwapState.vwap = vwapState.cumulativeVol > 0 ? vwapState.cumulativePV / vwapState.cumulativeVol : null;
                });
                tradeBuffer = tradeBuffer.filter(t => (currentTime - t.time) <= WINDOW_DURATION_MS);
            }
        });

        ws.on('close', () => {
            if (watchdog) clearTimeout(watchdog);
            console.log(`[Pipeline] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
            setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
        });

        ws.on('error', (err) => {
            console.error('[CRITICAL] Stream error:', err.message);
            ws.close();
        });
    }

    connect();
}

function getVolumeMetrics() {
    let buyVolume = 0;
    let sellVolume = 0;
    tradeBuffer.forEach(t => {
        if (t.side === 'B') buyVolume += t.size;
        if (t.side === 'A') sellVolume += t.size;
    });
    return { buyVolume, sellVolume };
}

function getVWAP() {
    return vwapState.vwap;
}

function getCVD() {
    let cvd = 0;
    tradeBuffer.forEach(t => {
        if (t.side === 'B') cvd += t.size;      // market buy = positive delta
        else if (t.side === 'A') cvd -= t.size;  // market sell = negative delta
    });
    return cvd;
}

function getCVDSpike(windowMs = 5000) {
    const cutoff = Date.now() - windowMs;
    let spike = 0;
    let volume = 0;
    tradeBuffer.forEach(t => {
        if (t.time >= cutoff) {
            if (t.side === 'B') spike += t.size;
            else if (t.side === 'A') spike -= t.size;
            volume += t.size;
        }
    });
    return { spike, volume };
}

function getSpikeDelta(windowMs = 5000) {
    if (tradeBuffer.length === 0) return 0;
    const cutoff = Date.now() - windowMs;
    const windowTrades = tradeBuffer.filter(t => t.time >= cutoff);
    if (windowTrades.length === 0) return 0;
    const oldestPrice = windowTrades[0].price;
    const newestPrice = windowTrades[windowTrades.length - 1].price;
    return newestPrice - oldestPrice;
}

const fundingState = {
    rate: null,
    direction: 'UNKNOWN',
    annualizedPct: null,
    lastFetch: null
};

/**
 * Fetches the predicted funding rate for BTC from Hyperliquid's REST API.
 * Uses the metaAndAssetCtxs endpoint to get current asset contexts.
 *
 * @returns {{ rate: number, annualizedPct: number, direction: 'POSITIVE'|'NEGATIVE'|'NEUTRAL' } | null}
 */
async function fetchPredictedFunding() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const res = await fetch('https://api.hyperliquid.xyz/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
            signal: controller.signal
        });

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        }

        const data = await res.json();
        const meta = data[0];
        const assetCtxs = data[1];

        // Find BTC index in the universe
        const btcIndex = meta.universe.findIndex(a => a.name === 'BTC');
        if (btcIndex === -1) {
            throw new Error('BTC not found in universe');
        }

        const ctx = assetCtxs[btcIndex];
        const rate = parseFloat(ctx.funding);
        // Hyperliquid does hourly funding: annualized = rate * 24 * 365 * 100
        const annualizedPct = rate * 24 * 365 * 100;

        let direction;
        if (rate > 0.00001) {
            direction = 'POSITIVE';
        } else if (rate < -0.00001) {
            direction = 'NEGATIVE';
        } else {
            direction = 'NEUTRAL';
        }

        return { rate, annualizedPct, direction };
    } catch (err) {
        console.error('[Funding] Error fetching predicted funding:', err.message);
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Refreshes the fundingState by calling fetchPredictedFunding.
 * Updates the cached state and logs the result.
 */
async function refreshFunding() {
    const result = await fetchPredictedFunding();
    if (result) {
        fundingState.rate = result.rate;
        fundingState.direction = result.direction;
        fundingState.annualizedPct = result.annualizedPct;
        fundingState.lastFetch = Date.now();

        const emoji = result.direction === 'POSITIVE' ? '📈' : result.direction === 'NEGATIVE' ? '📉' : '➡️';
        console.log(`[Funding] ${emoji} Rate: ${result.rate.toFixed(6)} | Annualized: ${result.annualizedPct.toFixed(2)}% | Direction: ${result.direction}`);
    } else {
        console.log('[Funding] Failed to refresh funding data.');
    }
}

module.exports = { startFeed, currentSnapshot, macroTrend, refreshMacroTrend, getVolumeMetrics, WINDOW_DURATION_MS, fundingState, fetchPredictedFunding, refreshFunding, vwapState, getVWAP, getCVD, getCVDSpike, getSpikeDelta };