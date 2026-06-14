class VirtualState {
    constructor(initialBalance = 1000.0) {
        this.balance = initialBalance; // Virtual USDC
        this.position = {
            size: 0,      // Positive for Long, Negative for Short
            entryPrice: 0,
            marginUsed: 0
        };
        this.makerFee = 0.00015; // Hyperliquid standard: 1 bps maker
        this.takerFee = 0.00045; // Hyperliquid standard: 3 bps taker
    }

    getBalance() {
        return this.balance;
    }

    getPosition() {
        return this.position;
    }

updatePosition(sizeChange, executionPrice, isTaker = true) {
        const feeRate = isTaker ? this.takerFee : this.makerFee;
        const fee = Math.abs(sizeChange) * executionPrice * feeRate;
        
        this.balance -= fee;

        if (this.position.size === 0) {
            // Opening a new position
            this.position.size = sizeChange;
            this.position.entryPrice = executionPrice;
        } else if (Math.sign(this.position.size) === Math.sign(sizeChange)) {
            // Adding to an existing position (averaging entry)
            const totalSize = this.position.size + sizeChange;
            this.position.entryPrice = ((this.position.size * this.position.entryPrice) + (sizeChange * executionPrice)) / totalSize;
            this.position.size = totalSize;
        } else {
            // Reducing, closing, or flipping a position
            const closedAbs = Math.min(Math.abs(this.position.size), Math.abs(sizeChange));
            const pnl = closedAbs * (executionPrice - this.position.entryPrice) * Math.sign(this.position.size);
            
            this.balance += pnl;
            const previousSize = this.position.size;
            this.position.size += sizeChange;
            
            if (this.position.size === 0) {
                // Position is flat
                this.position.entryPrice = 0;
            } else if (Math.sign(this.position.size) !== Math.sign(previousSize)) {
                // Position flipped (e.g., Long to Short). New entry price is the execution price.
                this.position.entryPrice = executionPrice;
            }
        }

        console.log(`\n[Ledger Update] Executed: ${sizeChange} BTC @ $${executionPrice} | Fee: $${fee.toFixed(4)} | Balance: $${this.balance.toFixed(2)}`);
    }
}

module.exports = VirtualState;