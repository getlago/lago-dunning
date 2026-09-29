export class AgentWorker {
  constructor({ agent, intervalMs = 300_000, runOnStart = false }) {
    this.agent = agent;
    this.intervalMs = intervalMs;
    this.runOnStart = runOnStart;
    this.timer = null;
    this.inFlight = null;
    this.pendingTrigger = null;
    this.startedAt = null;
    this.nextRunAt = null;
  }

  start() {
    if (this.timer) return;
    this.startedAt = new Date().toISOString();
    this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
    this.timer = setInterval(() => {
      this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
      this.trigger('schedule');
    }, this.intervalMs);
    this.timer.unref?.();
    if (this.runOnStart) queueMicrotask(() => this.trigger('startup'));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }

  trigger(reason = 'event') {
    if (this.inFlight) {
      this.pendingTrigger = reason;
      return this.inFlight;
    }
    this.inFlight = this.agent.run({ trigger: reason }).catch((error) => ({ error })).finally(() => {
      this.inFlight = null;
      if (this.pendingTrigger) {
        const next = this.pendingTrigger;
        this.pendingTrigger = null;
        queueMicrotask(() => this.trigger(next));
      }
    });
    return this.inFlight;
  }

  status() {
    return {
      enabled: Boolean(this.timer), inFlight: Boolean(this.inFlight), pendingTrigger: this.pendingTrigger,
      intervalMs: this.intervalMs, startedAt: this.startedAt, nextRunAt: this.nextRunAt
    };
  }
}
