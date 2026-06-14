const { startFeed, currentSnapshot } = require('./feed.js');
const VirtualState = require('./state.js');
const MatchingEngine = require('./engine.js');
// Initialize the ledger and the executioner
const state = new VirtualState(1000.0); // $1000 USDC starting balance
const engine = new MatchingEngine(state);

console.log('[System] Booting local simulator...');

// Boot the WebSocket firehose
const fetchHistoricalOHLC = require("./history");
fetchHistoricalOHLC()
function calculateSMA(closes, period) {
    if (closes.length < period) return null;
    const slice = closes.slice(-period);
    const sum = slice.reduce((acc, val) => acc + val, 0);
    return sum / period;
}
// Calculate the real-time SMA based on your historical fetch
    // (Ensure 'history.closes' is updated or passed correctly)
    const currentPrice = parseFloat(currentSnapshot.asks[0]); 
    const sma200 = calculateSMA(historicalData.closes, 200);
    
    // The Execution Rule: Target must be at least 0.15% away to justify Taker fees
    const MINIMUM_PROFIT_DISTANCE = currentPrice * 0.0015; 

    // --- EVALUATE BUY TRIGGER ---
    if (sellToBuyRatio >= TRIGGER_RATIO && position.size <= 0) {
        const distanceToTarget = sma200 - currentPrice;

        if (distanceToTarget >= MINIMUM_PROFIT_DISTANCE) {
            console.log(`\n[TRIGGER] Capitulation detected. SMA Target is $${distanceToTarget.toFixed(2)} away. Executing Dip Buy.`);
            engine.executeMarketOrder('buy', TRADE_SIZE_BTC, currentSnapshot);
            
            // Log the required exit price into state so the bot knows when to sell
            state.targetExit = sma200; 
        } else {
            // console.log(`[PASS] Capitulation detected, but SMA is too close ($${distanceToTarget.toFixed(2)}). Rejecting trade.`);
        }
    }

    // --- EVALUATE EXIT TRIGGER (Mean Reversion) ---
    if (position.size > 0 && currentPrice >= state.targetExit) {
        console.log(`\n[EXIT] Mean reversion achieved. Price crossed SMA target ($${state.targetExit}). Executing Take-Profit.`);
        engine.executeMarketOrder('sell', position.size, currentSnapshot);
        state.targetExit = null;
    }
startFeed(() => {
    console.log('[System] Market data synced. Commencing simulation sequence.');
    
    // Simulate a 0.5 BTC Market Buy after 3 seconds
    setTimeout(() => {
        engine.executeMarketOrder('buy', 0.5, currentSnapshot);
    }, 3000);

    // Simulate a 0.5 BTC Market Sell after 10 seconds to close the position
    setTimeout(() => {
        engine.executeMarketOrder('sell', 0.5, currentSnapshot);
        
        // Print the final ledger report
        console.log('\n--- Final Simulation State ---');
        console.log(`Balance: $${state.getBalance().toFixed(2)} USDC`);
        console.log(`Position: ${state.getPosition().size} BTC`);
        
        process.exit(0);
    }, 10000);
});