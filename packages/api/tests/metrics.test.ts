import { describe, it, expect } from "vitest";
import { Metrics } from "../src/services/metrics.js";

describe("Metrics", () => {
  it("renders counter + histogram in Prometheus text format", () => {
    const m = new Metrics();
    m.registerCounter("http_requests_total", "HTTP reqs");
    m.registerHistogram("http_ms", "HTTP dur", [10, 100, 1000]);

    m.inc("http_requests_total", { method: "GET", status: "200" });
    m.inc("http_requests_total", { method: "GET", status: "200" });
    m.inc("http_requests_total", { method: "POST", status: "500" });
    m.observe("http_ms", 5, { method: "GET" });
    m.observe("http_ms", 50, { method: "GET" });
    m.observe("http_ms", 5000, { method: "GET" });

    const out = m.toPrometheus();
    expect(out).toContain("# TYPE http_requests_total counter");
    expect(out).toContain('http_requests_total{method="GET",status="200"} 2');
    expect(out).toContain('http_requests_total{method="POST",status="500"} 1');
    expect(out).toContain("# TYPE http_ms histogram");
    expect(out).toContain('http_ms_bucket{method="GET",le="10"}');
    expect(out).toContain('http_ms_count{method="GET"} 3');
    expect(out).toContain('http_ms_sum{method="GET"} 5055');
  });
});
