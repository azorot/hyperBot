const fs = require('fs');
const { StrategyInstance, indicators } = require('./multi_sim.js');

const { vwapState } = require('./feed.js');

async function runSweeper() {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║               BACKTEST SWEEPER — HYPERBOT V5.1                 ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');

    const candlesData = fs.readFileSync('historical_candles_1m.json', 'utf8');
    const candles = JSON.parse(candlesData);

    const multipliers = [0.0004, 0.0005, 0.0006, 0.0007, 0.0008, 0.0009];
    const simulations = multipliers.map(m => new StrategyInstance(m));

    const originalDateNow = Date.now;

    console.log(`Loaded ${candles.length} historical 1m candles. Running simulation...`);

    let simulatedTime = candles[0].t;
    Date.now = () => simulatedTime;
    let tickCount = 0;

    // Initialize VWAP state
    vwapState.cumulativePV = 0;
    vwapState.cumulativeVol = 0;
    vwapState.vwap = null;
    vwapState.resetDay = new Date(simulatedTime).getUTCDate();

    // Initialize ATR arrays
    const trueRanges = [];
    let prevClose = parseFloat(candles[0].o);

    for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        simulatedTime = c.t;

        const open = parseFloat(c.o);
        const high = parseFloat(c.h);
        const low = parseFloat(c.l);
        const close = parseFloat(c.c);
        const volume = parseFloat(c.v);
        const numTrades = c.n;

        // Calculate ATR
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trueRanges.push(tr);
        if (trueRanges.length > 14) trueRanges.shift();
        
        const atr = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
        indicators.atr = atr;
        indicators.fastAtr = atr; // Use same for fast
        prevClose = close;

        // Step 1: Directional Volume Bias
        const isGreen = close > open;
        const buyBias = isGreen ? 0.8 : 0.2; // 80% biased toward the candle's direction

        const baseTradeSize = volume / numTrades;
        const timeStep = 60000 / numTrades;

        // Check if day changed to reset VWAP
        const currentDay = new Date(simulatedTime).getUTCDate();
        if (currentDay !== vwapState.resetDay) {
            vwapState.cumulativePV = 0;
            vwapState.cumulativeVol = 0;
            vwapState.vwap = null;
            vwapState.resetDay = currentDay;
        }

        for (let j = 0; j < numTrades; j++) {
            simulatedTime = c.t + j * timeStep;
            const side = Math.random() < buyBias ? 'B' : 'A';
            const price = open + (close - open) * (j / numTrades); 
            
            let tradeSize = baseTradeSize;

            // Step 2: VWAP Tracking Synthesis
            if (vwapState.vwap) {
                const vwapDist = Math.abs((price - vwapState.vwap) / vwapState.vwap);
                if (vwapDist <= 0.002) {
                    // Price is in VWAP zone: dynamically spike volume to simulate front-running
                    tradeSize *= 3.0; // 3x volume spike
                }
            }

            vwapState.cumulativePV += price * tradeSize;
            vwapState.cumulativeVol += tradeSize;
            vwapState.vwap = vwapState.cumulativePV / vwapState.cumulativeVol;

            const trade = {
                time: simulatedTime,
                price: price,
                size: tradeSize,
                side: side
            };

            for (const sim of simulations) {
                sim.addTrade(trade);
            }

            if (j % 10 === 0) {
                const bestBid = price - 0.5;
                const bestAsk = price + 0.5;

                for (const sim of simulations) {
                    try {
                        sim.onTick(bestAsk, bestBid);
                    } catch (e) {}
                }
                tickCount++;
            }
        }

        if (i % 1000 === 0 && i > 0) {
            console.log(`Processed ${i} candles...`);
        }
    }

    // Restore Date.now
    Date.now = originalDateNow;

    console.log('\n================================================================');
    console.log(`Backtest Complete. Processed ${candles.length} candles, ${tickCount} ticks.`);
    console.log('Final Performance:');
    
    for (const sim of simulations) {
        console.log(`\n[Multiplier ${sim.name}]`);
        console.log(`Balance: $${sim.state.getBalance().toFixed(2)} | Trades: ${sim.tracker.trades.length}`);
    }
}

runSweeper().catch(console.error);
