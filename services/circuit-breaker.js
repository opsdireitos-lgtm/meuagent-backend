class CircuitBreaker {
  constructor(name, threshold = 5, cooldownMs = 30000) {
    this.name = name;
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.lastFailure = 0;
    this.state = "closed";
  }

  check() {
    const now = Date.now();
    if (this.state === "open") {
      if (now - this.lastFailure > this.cooldownMs) {
        this.state = "half-open";
        console.log(`[CircuitBreaker:${this.name}] half-open, allowing probe`);
        return { allowed: true };
      }
      return { allowed: false, reason: `circuit_open (failures=${this.failures})` };
    }
    return { allowed: true };
  }

  recordSuccess() {
    this.failures = 0;
    this.state = "closed";
  }

  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "open";
      console.error(`[CircuitBreaker:${this.name}] OPENED after ${this.failures} failures`);
    }
  }

  getState() {
    return { state: this.state, failures: this.failures };
  }
}

const webhookCircuit = new CircuitBreaker("webhook", 5, 30000);
const followUpCircuit = new CircuitBreaker("follow-up", 3, 60000);
const bulkCircuit = new CircuitBreaker("bulk", 3, 60000);

module.exports = { CircuitBreaker, webhookCircuit, followUpCircuit, bulkCircuit };
