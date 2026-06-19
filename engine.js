
class MatchingEngine {
    constructor(state) {
        this.state = state;
    }

    executeMarketOrder(side, size, currentSnapshot) {
        let remainingSize = size;
        let totalCost = 0;
        
        // Buy orders walk up the Asks. Sell orders walk down the Bids.
        const bookSide = side === 'buy' ? currentSnapshot.asks : currentSnapshot.bids;
        
        if (!bookSide || bookSide.length === 0) {
            console.log(`[Engine Error] Order book is empty or disconnected.`);
            return;
        }

        console.log(`\n[Engine] Initiating Market ${side.toUpperCase()} for ${size} BTC...`);

        for (let i = 0; i < bookSide.length; i++) {
            const levelPrice = parseFloat(bookSide[i].px);
            const levelSize = parseFloat(bookSide[i].sz);

            if (remainingSize <= levelSize) {
                // The current book level can absorb the remaining order
                totalCost += remainingSize * levelPrice;
                remainingSize = 0;
                break;
            } else {
                // The order chews through the entire level; keep moving deeper
                totalCost += levelSize * levelPrice;
                remainingSize -= levelSize;
            }
        }

        if (remainingSize > 0) {
            console.log(`[Engine Warning] Order exceeds visible book depth. Unfilled: ${remainingSize} BTC`);
        }

        const filledSize = size - remainingSize;
        if (filledSize === 0) return;

        const averagePrice = totalCost / filledSize;
        const topOfBookPrice = parseFloat(bookSide[0].px);
        const slippage = Math.abs(averagePrice - topOfBookPrice);
        const slippagePct = averagePrice > 0 ? slippage / averagePrice : 0;

        console.log(`[Engine] Fill complete. Avg Price: $${averagePrice.toFixed(2)} | Slippage: $${slippage.toFixed(2)} / BTC`);

        if (slippagePct > 0.0005) {
            console.log(`[WARNING] High Slippage Detected: ${(slippagePct * 100).toFixed(3)}% (> 0.05% threshold). Execution efficiency degraded.`);
        }

        // Format for the state ledger: positive for buy (long), negative for sell (short)
        const sizeChange = side === 'buy' ? filledSize : -filledSize;
        
        // Market orders always pay the taker fee
        this.state.updatePosition(sizeChange, averagePrice, true);
    }
}

module.exports = MatchingEngine;