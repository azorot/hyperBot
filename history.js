const fs = require('fs');

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
 * Fetches a single batch of candles from the Hyperliquid API.
 */
async function fetchCandlesBatch(coin, interval, startTime, endTime) {
    const payload = {
        type: "candleSnapshot",
        req: { coin, interval, startTime, endTime }
    };
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return await response.json();
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

/**
 * Fetches a large number of candles from the Hyperliquid API using pagination.
 */
async function fetchManyCandles(coin = 'BTC', interval = '1m', count = 10000) {
    let allCandles = [];
    let endTime = Date.now();
    const intervalMs = getIntervalMs(interval);
    
    console.log(`[Data] Fetching ${count} historical candles for ${coin} via pagination...`);
    
    while (allCandles.length < count) {
        const batchSize = Math.min(5000, count - allCandles.length);
        const startTime = endTime - (intervalMs * (batchSize + 5));
        
        try {
            const batch = await fetchCandlesBatch(coin, interval, startTime, endTime);
            if (!batch || batch.length === 0) {
                break;
            }
            
            // Sort chronological ascending
            batch.sort((a, b) => a.t - b.t);
            
            allCandles = batch.concat(allCandles);
            
            // If the batch returns significantly less than batchSize, we may have reached the start of historical records
            if (batch.length < batchSize * 0.5) {
                break;
            }
            
            endTime = batch[0].t - 1;
            
            // Small pause to avoid rate limiting
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {
            console.error(`[Data] Batch fetch error:`, e.message);
            break;
        }
    }
    
    // Deduplicate and sort
    const seen = new Set();
    const unique = [];
    allCandles.forEach(c => {
        if (!seen.has(c.t)) {
            seen.add(c.t);
            unique.push(c);
        }
    });
    unique.sort((a, b) => a.t - b.t);
    
    return unique.slice(-count);
}

/**
 * Loads candles from a local file, syncs any missing latest candles from API, and saves them.
 */
async function loadAndSyncCandles(coin = 'BTC', interval = '1m', count = 10000, cacheFile = 'historical_candles_1m.json') {
    let candles = [];
    const now = Date.now();
    const intervalMs = getIntervalMs(interval);
    
    if (fs.existsSync(cacheFile)) {
        try {
            candles = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            console.log(`[Data] Loaded ${candles.length} candles from local cache file: ${cacheFile}`);
        } catch (e) {
            console.error(`[Data] Failed to parse cache file:`, e.message);
        }
    }
    
    // Sync if cache has fewer candles than requested, or if the latest candle is older than 2 minutes
    const needsSync = candles.length < count || (candles.length > 0 && (now - candles[candles.length - 1].t) > (intervalMs * 2));
    
    if (needsSync) {
        if (candles.length === 0) {
            // Cold start
            candles = await fetchManyCandles(coin, interval, count);
        } else {
            // Warm sync
            const lastCandleTime = candles[candles.length - 1].t;
            console.log(`[Data] Cache out of date. Syncing candles since ${new Date(lastCandleTime).toISOString().slice(11, 19)}...`);
            try {
                const newBatch = await fetchCandlesBatch(coin, interval, lastCandleTime + 1, now);
                if (newBatch && newBatch.length > 0) {
                    newBatch.sort((a, b) => a.t - b.t);
                    candles = candles.concat(newBatch);
                    console.log(`[Data] Synced ${newBatch.length} new candles from API.`);
                }
            } catch (e) {
                console.error(`[Data] Failed to sync new candles:`, e.message);
            }
        }
        
        // Deduplicate, sort and slice to the requested count
        const seen = new Set();
        const unique = [];
        candles.forEach(c => {
            if (!seen.has(c.t)) {
                seen.add(c.t);
                unique.push(c);
            }
        });
        unique.sort((a, b) => a.t - b.t);
        candles = unique.slice(-count);
        
        // Write back to cache file
        try {
            fs.writeFileSync(cacheFile, JSON.stringify(candles, null, 2));
            console.log(`[Data] Saved ${candles.length} candles to cache file: ${cacheFile}`);
        } catch (e) {
            console.error(`[Data] Failed to write cache file:`, e.message);
        }
    } else {
        console.log(`[Data] Cache is fully synchronized and up to date.`);
    }
    
    return candles;
}

/**
 * Formats a candle array into closings, high, and low arrays for indicators.
 */
function formatCandleArrays(candles) {
    const closes = candles.map(c => parseFloat(c.c));
    const highs = candles.map(c => parseFloat(c.h));
    const lows = candles.map(c => parseFloat(c.l));
    return { closes, highs, lows };
}

/**
 * Convenience wrapper to fetch hourly candles for macro trend analysis.
 */
async function fetchHourlyCandles(coin = 'BTC', periods = 200) {
    return fetchHistoricalOHLC(coin, '1h', periods);
}

module.exports = { 
    fetchHistoricalOHLC, 
    fetchHourlyCandles, 
    loadAndSyncCandles, 
    formatCandleArrays 
};