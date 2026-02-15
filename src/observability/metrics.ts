export interface MetricEvent {
  name: string;
  value?: number;
  tags?: Record<string, string>;
}

export class MetricsCollector {
  private readonly enabled: boolean;
  private readonly counters = new Map<string, number>();

  constructor(enabled: boolean = parseBoolean(process.env.METRICS_ENABLED)) {
    this.enabled = enabled;
  }

  increment(name: string, by: number = 1): void {
    if (!this.enabled) {
      return;
    }
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + by);
  }

  record(event: MetricEvent): void {
    if (!this.enabled) {
      return;
    }
    const value = event.value ?? 1;
    this.increment(event.name, value);
  }

  get(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true";
}
