/**
 * Token Bucket Rate Limiter
 * Mirrors Hyperliquid's API rate limiting: 100 max tokens, refilling at 10/sec.
 * Gate all outbound API calls through this before going live.
 */
class RateLimiter {
    constructor(maxTokens = 100, refillRate = 10) {
        this.tokens = maxTokens;
        this.max = maxTokens;
        this.refillRate = refillRate; // tokens per second
        this.lastRefill = Date.now();
    }

    _refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.max, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
    }

    canSend() {
        this._refill();
        return this.tokens >= 1;
    }

    consume() {
        this._refill();
        if (this.tokens < 1) {
            console.log('[RateLimit] Token bucket empty. Request blocked.');
            return false;
        }
        this.tokens--;
        return true;
    }

    getTokens() {
        this._refill();
        return Math.floor(this.tokens);
    }
}

module.exports = RateLimiter;
