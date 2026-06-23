const WebSocket = require('ws');

const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

ws.on('open', () => {
    console.log('Connected to Hyperliquid WS.');
    ws.send(JSON.stringify({
        method: "subscribe",
        subscription: { type: "trades", coin: "BTC" }
    }));
});

let count = 0;
ws.on('message', (data) => {
    const response = JSON.parse(data);
    if (response.channel === 'trades' && response.data) {
        const localTime = Date.now();
        response.data.forEach(trade => {
            count++;
            const drift = localTime - trade.time;
            console.log(`Trade #${count} | Local: ${localTime} | Exchange: ${trade.time} | Drift: ${drift}ms | Size: ${trade.sz} BTC`);
        });
        if (count >= 10) {
            console.log('Done 10 trades, closing.');
            ws.close();
            process.exit(0);
        }
    }
});

ws.on('error', (err) => {
    console.error('WS Error:', err);
});
