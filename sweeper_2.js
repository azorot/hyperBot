const fs = require('fs');
const { StrategyInstance, indicators } = require('./multi_sim.js');

const { vwapState, currentSnapshot } = require('./feed.js');

async function runSweeper() {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║               BACKTEST SWEEPER — HYPERBOT V5.1                 ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');

    let limit = 2000;
    for (let i = 2; i < process.argv.length; i++) {
        const arg = process.argv[i];
        if (arg.startsWith('--candles=') || arg.startsWith('--limit=') || arg.startsWith('--ticks=')) {
            const val = parseInt(arg.split('=')[1], 10);
            if (!isNaN(val)) limit = val;
        } else if (arg === '--candles' || arg === '--limit' || arg === '-c' || arg === '--ticks') {
            const nextArg = process.argv[i + 1];
            if (nextArg) {
                const val = parseInt(nextArg, 10);
                if (!isNaN(val)) {
                    limit = val;
                    i++;
                }
            }
        }
    }

    const candlesData = fs.readFileSync('historical_candles_1m.json', 'utf8');
    const allCandles = JSON.parse(candlesData);
    const limitCount = Math.min(limit, allCandles.length);
    const candles = allCandles.slice(-limitCount);

    const multipliers = [0.0004, 0.0005, 0.0006, 0.0007, 0.0008, 0.0009, 0.0010];
    const simulations = multipliers.map(m => new StrategyInstance(m));

    const originalDateNow = Date.now;

    console.log(`Loaded ${candles.length} historical 1m candles. Running simulation...`);

    let simulatedTime = candles[0].t;
    Date.now = () => simulatedTime;
    let tickCount = 0;
    let lastPrice = parseFloat(candles[0].o);

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
            let price = open + (close - open) * (j / numTrades); 
            
            let tradeSize = baseTradeSize;

            // Step 2: VWAP Tracking Synthesis (VWAP Kill Zone)
            const inZone = vwapState.vwap && (Math.abs((price - vwapState.vwap) / vwapState.vwap) <= 0.002);
            if (inZone) {
                // Price is in VWAP zone: simulate panic volume and force a price delta jump
                const randomFactor = 5.0 + Math.random() * 5.0;
                tradeSize *= randomFactor;
                price += isGreen ? 1.5 : -1.5;
            } else {
                // Outside the zone: starve baseline noise
                tradeSize *= 0.1;
            }

            vwapState.cumulativePV += price * tradeSize;
            vwapState.cumulativeVol += tradeSize;
            vwapState.vwap = vwapState.cumulativePV / vwapState.cumulativeVol;
            lastPrice = price;

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

                // Populate currentSnapshot to allow the virtual matching engine to execute trades
                currentSnapshot.bids = [{ px: bestBid.toString(), sz: '10000.0' }];
                currentSnapshot.asks = [{ px: bestAsk.toString(), sz: '10000.0' }];

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

    // Cleanup loop: Force close any open positions at the final simulatedTime and price
    const finalPrice = lastPrice;
    const snapshot = {
        bids: [{ px: finalPrice.toString(), sz: '1000.0' }],
        asks: [{ px: finalPrice.toString(), sz: '1000.0' }]
    };

    for (const sim of simulations) {
        const position = sim.state.getPosition();
        if (position.size !== 0) {
            const side = position.size > 0 ? 'sell' : 'buy';
            const size = Math.abs(position.size);
            sim.state.tradeReason = 'FORCE_CLOSE_BACKTEST_END';
            sim.engine.executeMarketOrder(side, size, snapshot);

            // Record completed trades in tracker to ensure accurate final counts
            if (sim.state.completedTrades.length > sim.lastTradeCount) {
                for (let k = sim.lastTradeCount; k < sim.state.completedTrades.length; k++) {
                    const t = sim.state.completedTrades[k];
                    t.volMultiplier = sim.volMultiplier;
                    sim.tracker.recordTrade(t);
                    fs.appendFileSync('completed_trades_multi.jsonl', JSON.stringify(t) + '\n');
                }
                sim.lastTradeCount = sim.state.completedTrades.length;
            }
        }
    }

    // Restore Date.now
    Date.now = originalDateNow;

    console.log('\n================================================================');
    console.log(`Backtest Complete. Processed ${candles.length} candles, ${tickCount} ticks.`);
    console.log('Final Performance:');
    
    for (const sim of simulations) {
        const wins = sim.tracker.getWins().length;
        const losses = sim.tracker.getLosses().length;
        const winRate = sim.tracker.getWinRate();
        const profitFactor = sim.tracker.getProfitFactor();
        const pfStr = profitFactor === Infinity ? 'Infinity' : profitFactor.toFixed(2);

        console.log(`\n[Multiplier ${sim.name}]`);
        console.log(`Balance: $${sim.state.getBalance().toFixed(2)} | Trades: ${sim.tracker.trades.length}`);
        console.log(`Win/Loss Ratio: W:${wins} / L:${losses} (WR: ${(winRate * 100).toFixed(1)}%) | Profit Factor: ${pfStr}`);
    }
}

runSweeper().catch(console.error);
