const WebSocket = require('ws');

const currentSnapshot = {
    bids: [],
    asks: []
};

let tradeBuffer = [];
const WINDOW_DURATION_MS = 60 * 1000; // 60-second rolling window

function startFeed(onReady) {
    const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    let synced = false;

    ws.on('open', () => {
        console.log('[Pipeline] Connected to Hyperliquid L1. Subscribing to streams...');
        
        // Subscribe to book depth for pricing execution
        ws.send(JSON.stringify({
            method: "subscribe",
            subscription: { type: "l2Book", coin: "BTC" }
        }));

        // Subscribe to trade flow for volume metrics
        ws.send(JSON.stringify({
            method: "subscribe",
            subscription: { type: "trades", coin: "BTC" }
        }));
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);
        const currentTime = Date.now();

        // Handle Order Book Updates
        if (response.channel === 'l2Book' && response.data) {
            currentSnapshot.bids = response.data.levels[0];
            currentSnapshot.asks = response.data.levels[1];
            
            if (!synced && currentSnapshot.bids.length > 0) {
                synced = true;
                onReady();
            }
        }

        // Handle Trade Flow Updates
        if (response.channel === 'trades' && response.data) {
            response.data.forEach(trade => {
                tradeBuffer.push({
                    size: parseFloat(trade.sz),
                    side: trade.side, // 'B' for Buy, 'A' for Sell
                    time: trade.time
                });
            });

            // Keep the window clean
            tradeBuffer = tradeBuffer.filter(t => (currentTime - t.time) <= WINDOW_DURATION_MS);
        }
    });

    ws.on('error', (err) => {
        console.error('[CRITICAL] Stream compromised:', err);
    });
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

module.exports = { startFeed, currentSnapshot, getVolumeMetrics, WINDOW_DURATION_MS };