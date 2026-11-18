'use strict';

/**
 * Small fixed-window counter held in memory on each instance.
 * With N instances behind the load balancer the effective limit is up to N times higher.
 */
class FixedWindowLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map();
    this.timer = setInterval(() => this.prune(), windowMs);
    this.timer.unref();
  }

  current(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) return null;
    return entry;
  }

  isBlocked(key) {
    const entry = this.current(key);
    return Boolean(entry && entry.count >= this.limit);
  }

  hit(key) {
    const now = Date.now();
    const entry = this.current(key, now);
    if (entry) entry.count += 1;
    else this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
  }

  reset(key) {
    this.entries.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
  }
}

module.exports = { FixedWindowLimiter };
