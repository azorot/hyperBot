# HyperBot Exit Conditions & Code Blocks

This document aggregates the implementation code blocks for every exit condition evaluated in the simulator engine ([multi_sim.js](file:///home/azoroth/hyperbot/hyperBot/multi_sim.js)).

---

## 1. 15-Minute Emergency Kill Switch (`TIMEOUT_15M`)
If the trade remains open for 15 minutes or longer without hit triggers, a Post-Only Maker limit exit order is submitted at the best spread price to close the trade and prevent stuck positions.

```javascript
        // --- 15-MINUTE KILL SWITCH ---
        if (elapsed >= 900000) {
            const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
            this.logSignal('15-MINUTE KILL SWITCH', [
                `⏰ Time limit reached (15m). Force closing position via Post-Only Limit Order.`,
                `${side} entry: $${entry.toFixed(2)} | PnL: $${pnl.toFixed(2)}`,
                `Action: POST LIMIT EXIT @ spread`
            ]);
            this.state.tradeReason = 'TIMEOUT_15M';
            this.engine.postLimitExit(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
            return true;
        }
```

---

## 2. Hard Stop-Loss (`HARD_STOP`)
A strict protection trigger that exits the trade via a market Taker order immediately if the price breaches the dynamic hard stop.

```javascript
        // --- HARD STOP ---
        const hardHit = isLong ? midPrice <= this.dynamicHardStop : midPrice >= this.dynamicHardStop;
        if (hardHit) {
            const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
            this.logSignal('HARD STOP-LOSS', [
                `⛔ Price $${midPrice.toFixed(2)} breached hard stop $${this.dynamicHardStop.toFixed(2)}`,
                `${side} entry: $${entry.toFixed(2)} | PnL: $${pnl.toFixed(2)} | Elapsed: ${formatDuration(elapsed)}`,
                `Action: CLOSE @ market (Taker)`
            ]);
            this.state.tradeReason = 'HARD_STOP';
            this.engine.executeMarketOrder(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);

            this.state.setCooldown('LONG', COOLDOWN_MS);
            this.state.setCooldown('SHORT', COOLDOWN_MS);
            this.resetTradeState();
            return true;
        }
```

---

## 3. Momentum Invalidation / Scratch Trade (`MOMENTUM_INVALIDATION`)
If the position has been held for 60 seconds without breaking even on taker fees (`clearedFees` is false) and goes underwater (`uPnL < 0`), the momentum is deemed dead. The trade is aborted via a Post-Only Maker limit exit to minimize transaction costs.

```javascript
            // ─── TIME-BASED MOMENTUM INVALIDATION (The 60s Rule) ───
            if (elapsed >= 60000 && !this.state.clearedFees) {
                const uPnL = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);

                // If the trade is fundamentally underwater after 60 seconds, the momentum failed.
                if (uPnL < 0) {
                    this.logSignal('MOMENTUM INVALIDATION — SCRATCH TRADE', [
                        `⏱️ Trade has been underwater for 60s without kinetic follow-through.`,
                        `The setup is dead. Aborting to limit-exit and preserve capital.`,
                        `PnL at invalidation: $${uPnL.toFixed(2)}`
                    ]);

                    this.state.tradeReason = 'MOMENTUM_INVALIDATION';

                    // Deploy a Post-Only Maker limit order to trap the spread. 
                    // Do not pay the taker fee to fix a dead trade.
                    this.engine.postLimitExit(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
                    return true;
                }
            }
```

---

## 4. Time-Decay Trailing Stop-Loss (`TRAIL_EXIT` / `FEE_THRESHOLD_FAILURE`)
Trailing stops are only modified once the price breaks even on taker fees. Once active, the trailing callback value decays linearly over time to lock in gains and limit losses, exiting the trade with a Post-Only order when breached.

```javascript
            // Calculate callback rate using custom volMultiplier instead of hardcoded 0.0015
            const initStop = this.currentCallback || this.volMultiplier;
            let cb = initStop;

            // Linear decay
            if (elapsed > 600000) {
                cb = 0.0002;
            } else if (elapsed > 60000) {
                const ratio = (elapsed - 60000) / (600000 - 60000);
                cb = initStop - ratio * (initStop - 0.0002);
                if (cb < 0.0002) cb = 0.0002;
            }

            // Taker fee break-even check
            const clearsFees = this.engine.clearsTakerFees(entry, midPrice, side);
            if (clearsFees && !this.state.clearedFees) {
                this.state.clearedFees = true;
                console.log(`[${ts()}] [Consider] Price action has cleared taker fee threshold ($${this.engine.getBreakEvenPrice(entry, side).toFixed(2)}). Trailing stop is now active and moving.`);
            }

            // Only allowed to move trailing stop if we have cleared taker fees
            if (this.state.clearedFees) {
                if (isLong) {
                    if (midPrice > this.trailHighWater) this.trailHighWater = midPrice;
                    const ns = this.trailHighWater * (1 - cb);
                    if (ns > this.currentStopPrice) this.currentStopPrice = ns;
                } else {
                    if (midPrice < this.trailHighWater) this.trailHighWater = midPrice;
                    const ns = this.trailHighWater * (1 + cb);
                    if (ns < this.currentStopPrice) this.currentStopPrice = ns;
                }
            }

            const trailHit = isLong ? midPrice <= this.currentStopPrice : midPrice >= this.currentStopPrice;
            if (trailHit) {
                const pnl = isLong ? (midPrice - entry) * position.size : (entry - midPrice) * Math.abs(position.size);
                this.logSignal('TRAIL STOP EXIT', [
                    `📉 Price $${midPrice.toFixed(2)} breached trail $${this.currentStopPrice.toFixed(2)}`,
                    `PnL: $${pnl.toFixed(2)} | Hold: ${formatDuration(elapsed)} | Callback: ${(cb * 100).toFixed(4)}%`,
                    `Cleared Fees: ${this.state.clearedFees ? 'YES' : 'NO'}`
                ]);
                this.state.tradeReason = this.state.clearedFees ? 'TRAIL_EXIT' : 'FEE_THRESHOLD_FAILURE';
                this.engine.postLimitExit(isLong ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
                return true;
            }
```

---

## 5. Adverse Funding Intercept (Hedge Override)
Checked right before the hourly funding rate settlement. If the position side faces adverse funding rates, the trailing callback value is tightened immediately to `0.0005` to force an early exit.

```javascript
    async checkFundingIntercept(position) {
        if (position.size === 0) return;
        const now = new Date();
        const minute = now.getUTCMinutes();
        if (minute < FUNDING_CHECK_MINUTE || minute > 55) return;
        if (now.getTime() - this.lastFundingCheck < 5 * 60000) return;
        this.lastFundingCheck = now.getTime();

        if (fundingState.rate === null || fundingState.direction === 'UNKNOWN') return;

        const isLong = position.size > 0;
        const dir = fundingState.direction;
        console.log(`[${ts()}] [FUNDING] T-${60 - minute}min | Rate: ${(fundingState.rate * 100).toFixed(4)}% | ${dir}`);

        const favorableForLong = dir === 'NEGATIVE';
        const favorableForShort = dir === 'POSITIVE';

        if ((isLong && !favorableForLong) || (!isLong && !favorableForShort)) {
            console.log(`[${ts()}] [FUNDING] Adverse funding. Tightening trail to ${(TRAIL_CB_FUNDING_BAD * 100).toFixed(2)}%`);
            if (this.trailActive) { this.currentCallback = TRAIL_CB_FUNDING_BAD; this.fundingOverride = true; }
        } else {
            console.log(`[${ts()}] [FUNDING] Favorable funding. Holding.`);
            this.fundingOverride = false;
        }
    }
```

---

## 6. Emergency Circuit Breaker (`EQUITY_FLOOR`)
If the overall account balance drops to or below the hard floor limit (`$80.00`), the engine closes any open position at market (Taker) and halts all future transactions.

```javascript
        // ═══ CIRCUIT BREAKER ═══
        if (this.state.isHalted()) {
            if (this.state.killed) {
                this.logSignal('⛔ EQUITY FLOOR — EMERGENCY SHUTDOWN', [`Balance: $${this.state.getBalance().toFixed(2)} <= $${EQUITY_FLOOR}`]);
                if (position.size !== 0) {
                    this.state.tradeReason = 'EQUITY_FLOOR';
                    this.engine.executeMarketOrder(position.size > 0 ? 'sell' : 'buy', Math.abs(position.size), currentSnapshot);
                    this.resetTradeState();
                }
                return;
            }
            return;
        }
```
