const fs = require('fs');

class VirtualState {
    constructor(initialBalance = 1000.0) {
        this.balance = initialBalance;
        this.initialBalance = initialBalance;
        this.dailyHighWaterMark = initialBalance;
        this.maxDrawdownPct = 0.05; // 5% daily max drawdown
        this.equityFloor = 80.0;    // Absolute floor — kill switch
        this.halted = false;
        this.killed = false;        // True = force shutdown
        this.position = {
            size: 0,
            entryPrice: 0,
            marginUsed: 0
        };
        this.targetExit = null;
        this.tradeReason = null; // Set before executing a trade for "Why" tagging
        this.makerFee = 0.00015;
        this.takerFee = 0.00045;

        // Round-trip trade tracking
        this.completedTrades = [];
        this._balanceAtEntry = 0;
        this._entryFees = 0;
        this._entryReason = null;

        this.tradeOpenTime = null;  // Timestamp (ms) when current position was opened
        this.trailStop = null;      // Trailing stop price tracked externally
        this.cooldowns = { LONG: 0, SHORT: 0 }; // Timestamps when cooldown expires
        this.tradePhaseStart = null; // Alias for tradeOpenTime, used by Chrono-Squeeze
    }

    getBalance() {
        return this.balance;
    }

    setCooldown(direction, durationMs = 30 * 60 * 1000) {
        this.cooldowns[direction] = Date.now() + durationMs;
        console.log(`[Cooldown] ${direction} entries locked for ${Math.round(durationMs / 60000)} minutes until ${new Date(this.cooldowns[direction]).toISOString().slice(11, 19)}`);
    }

    isCoolingDown(direction) {
        return Date.now() < this.cooldowns[direction];
    }

    clearCooldown(direction) {
        this.cooldowns[direction] = 0;
    }

    getPosition() {
        return this.position;
    }

    isHalted() {
        if (this.balance > this.dailyHighWaterMark) {
            this.dailyHighWaterMark = this.balance;
        }
        const drawdown = (this.dailyHighWaterMark - this.balance) / this.dailyHighWaterMark;
        if (drawdown >= this.maxDrawdownPct) {
            this.halted = true;
        }
        // Absolute equity floor — hard kill
        if (this.balance <= this.equityFloor) {
            this.killed = true;
            this.halted = true;
        }
        return this.halted;
    }

    updatePosition(sizeChange, executionPrice, isTaker = true) {
        const feeRate = isTaker ? this.takerFee : this.makerFee;
        const fee = Math.abs(sizeChange) * executionPrice * feeRate;
        let pnl = 0;
        const balanceBeforeFee = this.balance;

        this.balance -= fee;

        if (this.position.size === 0) {
            // Opening a new position
            this._balanceAtEntry = balanceBeforeFee;
            this._entryFees = fee;
            this._entryReason = this.tradeReason;
            this.tradeOpenTime = Date.now();
            this.position.size = sizeChange;
            this.position.entryPrice = executionPrice;

        } else if (Math.sign(this.position.size) === Math.sign(sizeChange)) {
            // Adding to existing position
            this._entryFees += fee;
            const totalSize = this.position.size + sizeChange;
            this.position.entryPrice = ((this.position.size * this.position.entryPrice) + (sizeChange * executionPrice)) / totalSize;
            this.position.size = totalSize;

        } else {
            // Reducing, closing, or flipping
            const savedEntryPrice = this.position.entryPrice;
            const savedSide = this.position.size > 0 ? 'LONG' : 'SHORT';
            const closedAbs = Math.min(Math.abs(this.position.size), Math.abs(sizeChange));
            pnl = closedAbs * (executionPrice - this.position.entryPrice) * Math.sign(this.position.size);

            this.balance += pnl;
            const previousSize = this.position.size;
            this.position.size += sizeChange;

            if (this.position.size === 0) {
                const totalFees = this._entryFees + fee;
                this.completedTrades.push({
                    timestamp: new Date().toISOString(),
                    side: savedSide,
                    entryPrice: savedEntryPrice,
                    exitPrice: executionPrice,
                    size: closedAbs,
                    pnl: pnl - totalFees,
                    grossPnl: pnl,
                    totalFees: totalFees,
                    balanceBefore: this._balanceAtEntry,
                    balanceAfter: this.balance,
                    entryReason: this._entryReason,
                    exitReason: this.tradeReason,
                    durationMs: Date.now() - this.tradeOpenTime
                });
                this.position.entryPrice = 0;
                this._balanceAtEntry = 0;
                this._entryFees = 0;
                this._entryReason = null;
                this.tradeOpenTime = null;
                this.trailStop = null;

            } else if (Math.sign(this.position.size) !== Math.sign(previousSize)) {
                const totalFees = this._entryFees + fee;
                this.completedTrades.push({
                    timestamp: new Date().toISOString(),
                    side: savedSide,
                    entryPrice: savedEntryPrice,
                    exitPrice: executionPrice,
                    size: closedAbs,
                    pnl: pnl - totalFees,
                    grossPnl: pnl,
                    totalFees: totalFees,
                    balanceBefore: this._balanceAtEntry,
                    balanceAfter: this.balance,
                    entryReason: this._entryReason,
                    exitReason: this.tradeReason,
                    durationMs: Date.now() - this.tradeOpenTime
                });
                // Flipping: the new side starts fresh
                this.tradeOpenTime = Date.now();
                this.trailStop = null;
                this.position.entryPrice = executionPrice;
                this._balanceAtEntry = this.balance;
                this._entryFees = 0;
                this._entryReason = this.tradeReason;
            }
        }

        console.log(`[Ledger] ${sizeChange > 0 ? 'BUY' : 'SELL'} ${Math.abs(sizeChange)} BTC @ $${executionPrice.toFixed(2)} | Fee: $${fee.toFixed(4)} | PnL: $${pnl.toFixed(2)} | Balance: $${this.balance.toFixed(2)}`);

        // Persist to JSONL ledger with "Why" tag
        const entry = {
            timestamp: new Date().toISOString(),
            side: sizeChange > 0 ? 'BUY' : 'SELL',
            size: Math.abs(sizeChange),
            price: executionPrice,
            fee: fee,
            pnl: pnl,
            balance: this.balance,
            positionSize: this.position.size,
            positionEntry: this.position.entryPrice,
            reason: this.tradeReason
        };
        fs.appendFileSync('trade_ledger.jsonl', JSON.stringify(entry) + '\n');

        // Reset reason after use
        this.tradeReason = null;
    }
}

module.exports = VirtualState;