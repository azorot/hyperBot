//hyperliquid

const WebSocket = require('ws');

const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

// --- THE PROTOCOL PARAMETERS ---
//12000 for 200 min
//60 for 1 min
const WINDOW_DURATION_MS = 60 * 1000; // 60 seconds. Adjust this to 300000 for 5 minutes.
const DIP_BUY_RATIO = 2.5; // The Trigger: Sell volume is 2.5x higher than Buy volume (exhaustion)

let tradeBuffer = []; // Our localized memory bank

ws.on('open', () => {
    console.log('[SUCCESS] Connected to Hyperliquid L1. Ingesting BTC Volume...');
    
    const subscriptionPayload = {
        method: "subscribe",
        subscription: { type: "trades", coin: "BTC" }
    };
    ws.send(JSON.stringify(subscriptionPayload));
});

ws.on('message', (data) => {
    const response = JSON.parse(data);
    
    // Only process actual trade data streams
    if (response.channel === 'trades') {
        const trades = response.data;
        const currentTime = Date.now();
        
        // 1. Push new trades into the buffer array
        trades.forEach(trade => {
            tradeBuffer.push({
                price: parseFloat(trade.px),
                size: parseFloat(trade.sz),
                side: trade.side, // 'B' for Buy, 'A' for Sell (Ask)
                time: trade.time
            });
        });

        // 2. The Guillotine: Prune all trades that are older than our window
        tradeBuffer = tradeBuffer.filter(t => (currentTime - t.time) <= WINDOW_DURATION_MS);

        // 3. Aggregate the active volume
        let buyVolume = 0;
        let sellVolume = 0;

        tradeBuffer.forEach(t => {
            if (t.side === 'B') buyVolume += t.size;
            if (t.side === 'A') sellVolume += t.size;
        });

        // 4. Verbose Logging (Clear terminal so it acts like a live dashboard)
        console.clear(); 
		console.log(`[LIVE AGGREGATOR - ${(WINDOW_DURATION_MS/1000)/60}m WINDOW]`);
        console.log(`Total BTC Buys:  ${buyVolume.toFixed(4)}`);
        console.log(`Total BTC Sells: ${sellVolume.toFixed(4)}`);
        
        // Prevent division by zero logic errors
        if (buyVolume > 0 && sellVolume > 0) {
            const currentRatio = sellVolume / buyVolume;
            console.log(`Sell/Buy Ratio:  ${currentRatio.toFixed(2)}x`);

            // 5. The Execution Trigger
            if (currentRatio >= DIP_BUY_RATIO) {
                console.log(`\n[!!! TARGET ACQUIRED !!!] Extreme sell exhaustion detected. API payload triggered.`);
                // The HyperCore execution code goes here tomorrow
            }
        }
    }
});

ws.on('error', (err) => {
    console.error('[CRITICAL ERROR] Pipeline compromised:', err);
});

//60000:1
//x:200