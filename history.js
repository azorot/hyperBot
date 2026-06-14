const URL = 'https://api.hyperliquid.xyz/info';

function getIntervalMs(interval) {
    const unit = interval.slice(-1);
    const value = parseInt(interval.slice(0, -1));
    
    if (unit === 'm') return value * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'd') return value * 24 * 60 * 60 * 1000;
    return 60 * 1000; // Default to 1m
}

async function fetchHistoricalOHLC(coin = 'BTC', interval = '1m', periods = 200) {
    const intervalMs = getIntervalMs(interval);
    const endTime = Date.now();
    
    // Calculate the exact start time to pull slightly more than requested to be safe
    const startTime = endTime - (intervalMs * (periods + 5)); 

    const payload = {
        type: "candleSnapshot",
        req: {
            coin: coin,
            interval: interval,
            startTime: startTime,
            endTime: endTime
        }
    };

    try {
        console.log(`[System] Ripping historical ${interval} data for ${coin}...`);
        const response = await fetch(URL, {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' }
        });

        const candles = await response.json();

        if (!candles || candles.length === 0) {
            console.log('[Error] No historical data returned.');
            return null;
        }

        // Isolate the exact requested periods from the end of the array
        const targetCandles = candles.slice(-periods);

        const closes = targetCandles.map(c => parseFloat(c.c));
        const highs = targetCandles.map(c => parseFloat(c.h));
        const lows = targetCandles.map(c => parseFloat(c.l));

        console.log(`[Success] Memory bank loaded. Tracked ${closes.length} closing prices.`);
        console.log(`[Stats] Latest Close: $${closes[closes.length - 1]} | Latest High: $${highs[highs.length - 1]}`);
        
        return { closes, highs, lows };
    } catch (error) {
        console.error('[CRITICAL] Failed to fetch historical data:', error);
        return null;
    }
}

module.exports = fetchHistoricalOHLC;