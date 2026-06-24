# HyperBot V5.1 — Codebase Architecture & Documentation

This document provides a detailed overview of the system architecture, file structure, key functions, and core execution logic for the Hyperliquid crypto scalping bot project.

---

## 📁 Core Directory & File Breakdown

### 1. [index.js](file:///home/azoroth/hyperbot/hyperBot/index.js) (Live Paper-Trading Engine)
The entry point for the live trading sequence. Runs a single simulation instance subscribing to live market data without placing real exchange orders.
* **Core Logic**:
  - Sets up risk management limits (USDC capital scaling, leverage cap at 3x, absolute equity floors, and trading cooldowns).
  - Listens to the trade feed and calculates real-time indicators.
  - Implements the entry and exit state machine.
* **Key Functions**:
  - `checkVWAPEntry(midPrice, spread)`: Evaluates if price is within the VWAP proximity zone, checks if ATR meets volatility hurdles, assesses Cumulative Volume Delta (CVD) momentum, and triggers market buy/sell simulations.
  - `checkMicroSqueezeExit(midPrice, position)`: Manages active positions by evaluating trailing stops, hard stops, break-even targets, momentum invalidation (the 60s rule), and the 15-minute emergency kill switch.
  - `printConsolidatedScan(midPrice, spread)`: Logs periodic diagnostic updates (current price, indicators, CVD rates, and open position metrics).

---

### 2. [feed.js](file:///home/azoroth/hyperbot/hyperBot/feed.js) (Market Data WS Pipeline)
Handles incoming market data from the Hyperliquid API WebSocket feed.
* **Core Logic**:
  - Establishes a WebSocket connection to the exchange feed.
  - Subscribes to the order book snapshot (`l2Book`) and public trades channels.
  - Manages a rolling 60-second public trades buffer to compute order flow volume and delta.
  - Implements a 15-second heartbeat ping loop to prevent connection stalls and maintain priority.
  - Includes a 15-second watchdog timer to auto-terminate and reconnect if no packets arrive.
* **Key Functions / Exports**:
  - `startFeed(onTick)`: Establishes the WebSocket connection, manages retry/exponential backoff delay, configures the watchdog, and invokes the callback on book updates.
  - `getVolumeMetrics()`: Returns aggregated buy and sell volume from the 60-second window.
  - `getCVD()`: Calculates Cumulative Volume Delta (buys minus sells) for the window.
  - `getCVDSpike(windowMs)`: Detects sudden volume spikes within a sub-window (default 5s).
  - `getSpikeDelta(windowMs)`: Calculates the raw price change during a volume spike.
  - `vwapState`: Keeps track of recursive VWAP calculation parameters (`cumulativePV`, `cumulativeVol`, `vwap`, and daily resets).
  - `fundingState` & `refreshFunding()`: Periodically polls Hyperliquid's predicted hourly funding rates for hedge logic.

---

### 3. [feed2.js](file:///home/azoroth/hyperbot/hyperBot/feed2.js) (Minimal WebSocket Aggregator)
A simplified, lightweight test client for WebSocket ingestion.
* **Core Logic**:
  - Opens a connection to Hyperliquid WS and subscribes to the BTC `l2Book` stream.
  - Formats bid/ask depth snapshots and prints bid-ask spreads and liquidity depths.
  - Used for standalone testing of the raw exchange firehose connection.

---

### 4. [engine.js](file:///home/azoroth/hyperbot/hyperBot/engine.js) (Virtual Execution Matcher)
Simulates order fills, slippage, and fee calculations against simulated book depth.
* **Core Logic**:
  - Simulates execution of market orders (Takers) and limit orders (Makers).
  - Traverses the order book snapshot asks/bids depth sequentially to model slippage penalty.
* **Key Methods**:
  - `executeMarketOrder(side, size, currentSnapshot)`: Calculates the volume-weighted average price (VWAP) for simulated market orders by walking the bids/asks array. Subtracts taker fees (`0.00035`) and updates the account position.
  - `postLimitExit(side, size, currentSnapshot)`: Places a Post-Only Maker limit exit order at the best bid/ask.
  - `updateLimitExit(currentSnapshot)`: Adjusts the limit exit price dynamically as the spread moves (Maker execution styling), capturing execution rebates/maker fees (`0.00015`).

---

### 5. [multi_sim.js](file:///home/azoroth/hyperbot/hyperBot/multi_sim.js) (Parametric Backtest Coordinator)
Coordinates concurrent strategy simulation instances across a matrix of different parameters.
* **Core Logic**:
  - Defines the `StrategyInstance` class representing a single strategy variant.
  - Evaluates performance across different ATR volatility multiplier hurdles simultaneously (e.g. `0.0004` to `0.0009`).
  - Implements the core signal evaluation rules, entry/exit gating, and consolidated terminal logging used during simulation/backtesting.

---

### 6. [sweeper.js](file:///home/azoroth/hyperbot/hyperBot/sweeper.js) & [sweeper_2.js](file:///home/azoroth/hyperbot/hyperBot/sweeper_2.js) (Historical Backtesting Pipeline)
Bypasses the live WebSocket feed to run high-speed backtests against historical candle logs (`historical_candles_1m.json`).
* **Core Logic**:
  - Loads a specified slice of historical 1m candles (customizable via command-line flags).
  - Synthesizes order-flow ticks to reconstruct order flow metrics (ATR, VWAP, CVD, volume) dynamically.
  - Evaluates directional volume bias (80/20 buy/sell tick skew based on whether the historical candle closed green or red).
  - Simulates the **VWAP Kill Zone** (within 0.2% of VWAP) by multiplying tick sizes by 5x-10x and forcing a `1.5` price jump, and starves background noise outside of the zone.
  - Force-closes open positions at the end of the simulation and reports consolidated Win/Loss Ratios, Win Rates, and Profit Factors for each parameter.
* **Command-line Arguments Supported**:
  - `--candles=<count>`, `--limit=<count>`, `--ticks=<count>`, or `-c <count>` (specifies the candle range, defaults to `2000`).

---

### 7. [history.js](file:///home/azoroth/hyperbot/hyperBot/history.js) (REST Historical Data Client)
Integrates with Hyperliquid's HTTP endpoints for downloading and pagination of historical OHLC data.
* **Key Functions**:
  - `fetchHistoricalOHLC(coin, interval, periods)`: Retreives a specific number of OHLC candles.
  - `loadAndSyncCandles(coin, interval, count)`: Automatically fetches large sets of historical data (e.g. 10k candles), handles API pagination limits, and writes/syncs the data locally to a JSON file cache.
  - `formatCandleArrays(rawCandles)`: Maps API JSON formats into separate lists of highs, lows, and closes.
  - `fetchHourlyCandles(coin, periods)`: Retrieves hourly closes for macro-trend SMA identification.

---

### 8. [state.js](file:///home/azoroth/hyperbot/hyperBot/state.js) (Virtual Account Ledger)
Maintains paper trading account status and metrics.
* **Core Logic**:
  - Tracks margins, open sizes, entry prices, cash balances, and peak balances.
  - Monitors risk criteria (maximum daily drawdowns and equity floor kill switches).
* **Key Methods**:
  - `updatePosition(sizeChange, executionPrice, isTaker)`: Updates open position size and entry price. Adjusts account balance by adding trade PnL and subtracting maker or taker fees. Logs complete execution details to a persistent ledger file (`trade_ledger.jsonl`).

---

### 9. [stats.js](file:///home/azoroth/hyperbot/hyperBot/stats.js) (Performance & Statistics Analyzer)
Processes completed trades to calculate financial performance indicators.
* **Key Methods**:
  - `recordTrade(trade)`: Ingests completed trade data and calculates rolling drawdowns.
  - `getWinRate()` & `getProfitFactor()`: Calculates the ratio of winning trades and the overall gross profit/loss ratio.
  - `calculateSharpe()` & `calculateSortino()`: Computes standardized risk-adjusted returns (ratio of excess return over std dev or downside risk).
  - `printReport(currentBalance, tickCount, position, currentPrice)`: Prints a consolidated performance statement inside the terminal.

---

### 10. [ratelimit.js](file:///home/azoroth/hyperbot/hyperBot/ratelimit.js) (API Token Bucket Rate Limiter)
A client-side rate-limiting class.
* **Core Logic**:
  - Implements a token bucket algorithm matching Hyperliquid's API restrictions (100 tokens max, refills at 10 tokens/sec).
  - Prevents API threshold violations by gating HTTP request triggers.

---

### 11. [hyper.js](file:///home/azoroth/hyperbot/hyperBot/hyper.js) (Live Volume Aggregator Test Script)
A standalone utility that subscribes to the public BTC trade channel to log buy/sell volumes and calculate market exhaustion ratios.

---

### 12. [check_drift.js](file:///home/azoroth/hyperbot/hyperBot/check_drift.js) (WS Time Sync Tool)
Connects to the WS trades stream, compares local system time with exchange event timestamps, prints the time drift (in ms), and exits after processing 10 events.
