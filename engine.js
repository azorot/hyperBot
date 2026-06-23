
class MatchingEngine {
    constructor(state) {
        this.state = state;
        this.activeLimitOrder = null;
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

    getBreakEvenPrice(entryPrice, side, takerFeeRate = 0.00035) {
        if (side === 'buy' || side === 'LONG' || side > 0) {
            return entryPrice * (1 + takerFeeRate) / (1 - takerFeeRate);
        } else {
            return entryPrice * (1 - takerFeeRate) / (1 + takerFeeRate);
        }
    }

    clearsTakerFees(entryPrice, currentPrice, side, takerFeeRate = 0.00035) {
        if (side === 'buy' || side === 'LONG' || side > 0) {
            return currentPrice >= this.getBreakEvenPrice(entryPrice, side, takerFeeRate);
        } else {
            return currentPrice <= this.getBreakEvenPrice(entryPrice, side, takerFeeRate);
        }
    }

    postLimitExit(side, size, currentSnapshot) {
        if (!currentSnapshot || !currentSnapshot.asks || currentSnapshot.asks.length === 0) {
            console.log(`[Engine Error] Cannot post limit exit: order book disconnected.`);
            return;
        }

        const price = side === 'sell' ? parseFloat(currentSnapshot.asks[0].px) : parseFloat(currentSnapshot.bids[0].px);
        this.activeLimitOrder = {
            side,
            size,
            price
        };

        console.log(`\n[Engine] Posting Post-Only Limit Exit ${side.toUpperCase()} for ${size} BTC at $${price.toFixed(2)} (Maker)...`);
    }

    updateLimitExit(currentSnapshot) {
        if (!this.activeLimitOrder) return false;

        const { side, size, price } = this.activeLimitOrder;
        const bestBid = parseFloat(currentSnapshot.bids[0].px);
        const bestAsk = parseFloat(currentSnapshot.asks[0].px);

        // Check for fill:
        // Sell Limit order fills if bestBid matches or exceeds limit price
        // Buy Limit order fills if bestAsk matches or falls below limit price
        const filled = side === 'sell' ? (bestBid >= price) : (bestAsk <= price);

        if (filled) {
            console.log(`[Engine] Limit Exit Fill complete. Avg Price: $${price.toFixed(2)} (MAKER structure rebate captured)`);
            const sizeChange = side === 'buy' ? size : -size;
            // Pass false for isTaker to apply maker fee (0.00015)
            this.state.updatePosition(sizeChange, price, false);
            this.activeLimitOrder = null;
            return true;
        }

        // Modify order to drag against the current price (micro-spread boundary)
        const targetPrice = side === 'sell' ? bestAsk : bestBid;
        if (targetPrice !== price) {
            console.log(`[Engine] Dragging Limit Exit ${side.toUpperCase()} Price: $${price.toFixed(2)} → $${targetPrice.toFixed(2)}`);
            this.activeLimitOrder.price = targetPrice;
        }

        return false;
    }
}

module.exports = MatchingEngine;