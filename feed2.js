const WebSocket = require('ws');

const URL = 'wss://api.hyperliquid.xyz/ws';
const ws = new WebSocket(URL);


const currentSnapshot = {
    bids: [], // Array of { px: string, sz: string, n: number }
    asks: []
};

ws.on('open', () => {
    console.log('[System] Connected to Hyperliquid firehose.');
    
    // The strict subscription payload for L2 Book data
    const payload = {
        method: 'subscribe',
        subscription: {
            type: 'l2Book',
            coin: 'BTC' // Target the highest liquidity asset for testing
        }
    };
    
    ws.send(JSON.stringify(payload));
    console.log(`[System] Requested stream: ${payload.subscription.type} -> ${payload.subscription.coin}`);
});

ws.on('message', (data) => {
    const response = JSON.parse(data);
    
    // Hyperliquid sends a confirmation ack first, acknowledge it
    if (response.channel === 'subscriptionResponse') {
        console.log('[System] Subscription confirmed. Awaiting tick data...\n');
        return;
    }

    // Isolate and process the L2 Book data
    if (response.channel === 'l2Book') {
        const bookData = response.data;
        currentSnapshot.bids = bookData.levels[0];
        currentSnapshot.asks = bookData.levels[1];
        // levels[0] are Bids (Buyers), levels[1] are Asks (Sellers)
        const bids = bookData.levels[0]; 
        const asks = bookData.levels[1]; 
        
        const bestBid = parseFloat(bids[0].px);
        const bestAsk = parseFloat(asks[0].px);
        const spread = (bestAsk - bestBid).toFixed(2);

        // Output a clean, single-line log for visual confirmation
        console.log(`[${bookData.time}] Spread: $${spread} | Ask: $${bestAsk} (${asks[0].sz}) | Bid: $${bestBid} (${bids[0].sz})`);
        //console.log(`[System] Book Updated. Top Bid: ${currentSnapshot.bids[0].px}`);
        //console.log(`[System] Book Updated. Top Ask: ${currentSnapshot.asks[0].px}`);
    }
});

ws.on('close', () => {
    console.log('[System] Connection severed.');
});

ws.on('error', (err) => {
    console.error('[Error] WebSocket failure:', err);
});

// Add this to the bottom of feed.js
module.exports = { 
    startFeed: (onReady) => { /* your websocket logic, trigger onReady() when book populates */ }, 
    currentSnapshot 
};