# Hyperbot Multi-Simulator Project Rundown

Welcome back! Below is a comprehensive overview of where the Hyperbot project stands, focusing on the configuration, architecture, recent upgrades, simulation run metrics, and the strategic next steps.

---

## 1. System Architecture & File Structure

Hyperbot is designed as a simulated (paper trading) cryptocurrency scalping bot for the Hyperliquid BTC perpetual swaps market. It works by processing real-time WebSockets L2 order book data and trade feeds, calculating local execution slippage, tracking fees, and simulating a set of concurrent strategy configurations.

### Core Modules
*   **[multi_sim.js](file:///home/azoroth/hyperbot/hyperBot/multi_sim.js)**: The multi-parameter simulator. It concurrently runs four strategy instances with different volatility multipliers (`0.0007`, `0.0008`, `0.0009`, `0.0010`) to identify the optimal entry hurdle.
*   **[feed.js](file:///home/azoroth/hyperbot/hyperBot/feed.js)**: Subscribes to Hyperliquid's WebSockets for order book snapshots (`l2Book`) and trade events (`trades`), and computes rolling metrics such as **VWAP** and **CVD (Cumulative Volume Delta)**.
*   **[engine.js](file:///home/azoroth/hyperbot/hyperBot/engine.js)**: The execution engine. It matches virtual orders against the order bookasks/bids to account for real liquidity, maker/taker execution paths, and fees.
*   **[state.js](file:///home/azoroth/hyperbot/hyperBot/state.js)**: Tracks account balance, open positions, cooldown timers, risk limits (e.g., daily drawdown limits, equity floors), and appends to the trade ledger.
*   **[stats.js](file:///home/azoroth/hyperbot/hyperBot/stats.js)**: Computes Sharpe and Sortino ratios, win rates, and print summaries.

---

## 2. Latest Strategy Updates: Version 5.0.3

The system was updated to **V5.0.3** to solve critical baseline issues and widen execution parameters:

1.  **Baseline Reality Correction (Total Kinetic Energy)**
    *   **The Problem:** Previous iterations computed the CVD baseline rate using the net difference of buyers/sellers (`Math.abs(buyVolume - sellVolume) / 60`). In calm, balanced markets, this created a near-zero denominator. Even a small trade would register as a massive CVD spike (e.g. 15x), prompting erroneous entries.
    *   **The Fix:** We updated `updateCVDBaseline()` in [multi_sim.js](file:///home/azoroth/hyperbot/hyperBot/multi_sim.js#L159-L170) to measure the total background trading volume instead of the net delta:
        ```javascript
        const totalVol = buyVolume + sellVolume;
        this.cvdBaseline.avgRate = totalVol > 0 ? totalVol / 60 : 0;
        ```
2.  **Expanded Entry Cages**
    *   **VWAP Proximity:** Widened `VWAP_PROXIMITY_PCT` from `0.001` (0.1%) to `0.002` (0.2%). This allows the bot to capture high volume front-running the VWAP line for bounces or rejections.
    *   **CVD Spike Threshold:** Reduced `CVD_SPIKE_THRESHOLD` from `2.0` to `1.5`. A 1.5x increase in directional volume compared to background noise is now enough kinetic energy to confirm a micro-squeeze setup.
3.  **Capital Preservation Armor (Left Untouched)**
    *   **Volatility Hurdle Gating:** The entry must mathematically clear taker fees based on the 1-minute ATR. The volatility sweep multiplier ranges from `0.0007` to `0.0010`.
    *   **60-Second Scratch Rule (`MOMENTUM_INVALIDATION`):** If a trade is underwater after 60 seconds and has not cleared the fee hurdle, the bot exits immediately using a **Post-Only Maker limit order** to capture exchange rebates and scratch the trade without eating taker fees.

---

## 3. Analysis of Recent Simulation Runs

Recent log files show the multi-simulator running for extended periods, but executing **0 trades**:

*   **June 20th Simulation (`sim_log_multi_2026-06-20.txt`):**
    *   **Runtime:** 8h 1m 36s (2,282 ticks)
    *   **Trades Executed:** 0
*   **June 21st Simulation (`sim_log_multi_2026-06-21.txt`):**
    *   **Runtime:** 4h 25m 12s (2,902 ticks)
    *   **Trades Executed:** 0

### Why did the bot execute 0 trades?
1.  **Low Volatility & Tick Rate:** The ticks processed averaged 1 every 5.5 seconds. For a scalping strategy, this indicates quiet or disconnected periods.
2.  **Suffocating Volume Constraints:** The system requires a minimum volume of `MIN_VOLUME_THRESHOLD = 10.0` BTC in the rolling 60-second window before evaluating entries. In the log file scans, 60s volume was frequently around `0.20 - 0.40` BTC, far below the threshold.

### Proof of Concept (Historical Logs)
When trade activity is high, the engine successfully triggers. In [completed_trades_0.0007.jsonl](file:///home/azoroth/hyperbot/hyperBot/logs/completed_trades_0.0007.jsonl), we see previous successful executions:
*   **SHORT Entry (VWAP Rejection):** Opened at `$64,185.00` and closed at `$64,105.00` via **TRAIL_EXIT** (duration: 9.2 mins).
    *   *Result:* **+$2.20 Net PnL** after paying `$1.47` in transaction fees.
*   **LONG Entry (VWAP Bounce):** Opened at `$64,181.30` and closed at `$64,061.00` via **HARD_STOP** (duration: 1.3 mins).
    *   *Result:* **-$7.59 Net PnL** including `$2.06` in transaction fees.

---

## 4. Next Steps & Tactical Questions

To resume progress, we should focus on tuning the bot to trade under realistic market conditions:

1.  **Volume Threshold Re-calibration:** Is the `MIN_VOLUME_THRESHOLD` of `10.0` BTC too restrictive for off-peak hours? We could reduce this to `2.0` or `3.0` BTC to ensure the bot can trigger entries during normal, non-apocalyptic volume events.
2.  **Tick Stream Analysis:** Look into why the tick count was relatively low (1 tick per ~5.5s) despite high trade frequency. We may need to investigate the WebSocket feed stream parameters or potential connections drops.
3.  **Historical Backtest Sweeper:** Rather than running live paper trades and waiting, we can feed the engine the historical candlesticks from `historical_candles_1m.json` to backtest our volatility multipliers over a full week in seconds.
