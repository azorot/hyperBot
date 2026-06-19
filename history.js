const API_URL = 'https://api.hyperliquid.xyz/info';

function getIntervalMs(interval) {
    const unit = interval.slice(-1);
    const value = parseInt(interval.slice(0, -1));
    
    if (unit === 'm') return value * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'd') return value * 24 * 60 * 60 * 1000;
    return 60 * 1000; // Default to 1m
}

/**
 * Fetches OHLC candle data from Hyperliquid.
 * Can be called repeatedly for periodic indicator refresh.
 */
async function fetchHistoricalOHLC(coin = 'BTC', interval = '1m', periods = 200) {
    const intervalMs = getIntervalMs(interval);
    const endTime = Date.now();
    const startTime = endTime - (intervalMs * (periods + 5));

    const payload = {
        type: "candleSnapshot",
        req: { coin, interval, startTime, endTime }
    };

    try {
        console.log(`[Data] Fetching ${periods}x ${interval} candles for ${coin}...`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        const response = await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        const candles = await response.json();

        if (!candles || candles.length === 0) {
            console.log(`[Data] No ${interval} data returned.`);
            return null;
        }

        const targetCandles = candles.slice(-periods);
        const closes = targetCandles.map(c => parseFloat(c.c));
        const highs = targetCandles.map(c => parseFloat(c.h));
        const lows = targetCandles.map(c => parseFloat(c.l));

        console.log(`[Data] Loaded ${closes.length} ${interval} candles. Latest close: $${closes[closes.length - 1]}`);
        return { closes, highs, lows };
    } catch (error) {
        console.error(`[CRITICAL] Failed to fetch ${interval} data:`, error.message);
        return null;
    }
}

/**
 * Convenience wrapper to fetch hourly candles for macro trend analysis.
 */
async function fetchHourlyCandles(coin = 'BTC', periods = 200) {
    return fetchHistoricalOHLC(coin, '1h', periods);
}

module.exports = { fetchHistoricalOHLC, fetchHourlyCandles };