type Labels = Record<string, string>;

interface Counter { type: "counter"; help: string; values: Map<string, { labels: Labels; value: number }> }
interface Gauge { type: "gauge"; help: string; values: Map<string, { labels: Labels; value: number }> }
interface Histogram { type: "histogram"; help: string; buckets: number[]; values: Map<string, { labels: Labels; counts: number[]; sum: number; total: number }> }

export class Metrics {
  private counters = new Map<string, Counter>();
  private gauges = new Map<string, Gauge>();
  private histograms = new Map<string, Histogram>();

  registerCounter(name: string, help: string): void {
    if (!this.counters.has(name)) this.counters.set(name, { type: "counter", help, values: new Map() });
  }

  registerGauge(name: string, help: string): void {
    if (!this.gauges.has(name)) this.gauges.set(name, { type: "gauge", help, values: new Map() });
  }

  registerHistogram(name: string, help: string, buckets: number[]): void {
    if (!this.histograms.has(name)) this.histograms.set(name, { type: "histogram", help, buckets, values: new Map() });
  }

  inc(name: string, labels: Labels = {}, delta = 1): void {
    const c = this.counters.get(name) ?? { type: "counter" as const, help: "", values: new Map() };
    this.counters.set(name, c);
    const key = this.labelKey(labels);
    const existing = c.values.get(key) ?? { labels, value: 0 };
    existing.value += delta;
    c.values.set(key, existing);
  }

  gauge(name: string, labels: Labels, value: number): void {
    const g = this.gauges.get(name) ?? { type: "gauge" as const, help: "", values: new Map() };
    this.gauges.set(name, g);
    g.values.set(this.labelKey(labels), { labels, value });
  }

  observe(name: string, ms: number, labels: Labels = {}): void {
    const h = this.histograms.get(name);
    if (!h) return;
    const key = this.labelKey(labels);
    const entry = h.values.get(key) ?? { labels, counts: new Array(h.buckets.length).fill(0), sum: 0, total: 0 };
    for (let i = 0; i < h.buckets.length; i++) if (ms <= h.buckets[i]) entry.counts[i]++;
    entry.sum += ms;
    entry.total++;
    h.values.set(key, entry);
  }

  private labelKey(labels: Labels): string {
    return Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(",");
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [name, c] of this.counters) {
      if (c.help) lines.push(`# HELP ${name} ${c.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const v of c.values.values()) {
        lines.push(`${name}${this.renderLabels(v.labels)} ${v.value}`);
      }
    }
    for (const [name, g] of this.gauges) {
      if (g.help) lines.push(`# HELP ${name} ${g.help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const v of g.values.values()) {
        lines.push(`${name}${this.renderLabels(v.labels)} ${v.value}`);
      }
    }
    for (const [name, h] of this.histograms) {
      if (h.help) lines.push(`# HELP ${name} ${h.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const v of h.values.values()) {
        for (let i = 0; i < h.buckets.length; i++) {
          const labels = { ...v.labels, le: String(h.buckets[i]) };
          lines.push(`${name}_bucket${this.renderLabels(labels)} ${v.counts[i]}`);
        }
        lines.push(`${name}_bucket${this.renderLabels({ ...v.labels, le: "+Inf" })} ${v.total}`);
        lines.push(`${name}_sum${this.renderLabels(v.labels)} ${v.sum}`);
        lines.push(`${name}_count${this.renderLabels(v.labels)} ${v.total}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  private renderLabels(labels: Labels): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return "";
    return "{" + entries.map(([k, v]) => `${k}="${String(v).replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`).join(",") + "}";
  }
}

export const metrics = new Metrics();
metrics.registerCounter("clawhub_http_requests_total", "HTTP requests by method + status");
metrics.registerHistogram("clawhub_http_request_ms", "HTTP request duration", [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]);
metrics.registerCounter("clawhub_events_published_total", "Events published by type");
metrics.registerCounter("clawhub_changes_merged_total", "Changes merged by method");
metrics.registerCounter("clawhub_reviews_submitted_total", "Reviews submitted by verdict");
metrics.registerCounter("clawhub_ci_runs_total", "CI runs by terminal status");
metrics.registerCounter("clawhub_sast_findings_total", "SAST findings by severity");
metrics.registerCounter("clawhub_vuln_findings_total", "Dependency findings by severity");
metrics.registerCounter("clawhub_email_outbox_dead_total", "Outbox emails dropped after exhausting delivery retries");
metrics.registerCounter("clawhub_issue_number_conflict_total", "Issue-number allocation conflicts by outcome (retry | exhausted)");
// Phase 3/4 shard fleet.
metrics.registerCounter("clawhub_shard_request_total", "Forwarded requests to git shards by status");
metrics.registerCounter("clawhub_shard_circuit_state_change_total", "Circuit breaker state transitions");
metrics.registerCounter("clawhub_shard_failover_total", "Failover outcomes per shard");
metrics.registerCounter("clawhub_shard_lease_expired_total", "Shard lease expirations observed");
metrics.registerCounter("clawhub_shard_migration_total", "Repo migration outcomes");
metrics.registerCounter("clawhub_replication_entries_applied_total", "Ref-log entries applied by a replica shard");
metrics.registerCounter("clawhub_repo_backup_total", "Repo backup attempts");
metrics.registerCounter("clawhub_repo_restore_total", "Repo restore attempts");
metrics.registerGauge("clawhub_shard_health", "Shard health (1=healthy,0=unhealthy)");
metrics.registerGauge("clawhub_shard_circuit_open", "Shard circuit breaker open state");
metrics.registerGauge("clawhub_replication_last_seq", "Last ref_log seq applied by a replica");
