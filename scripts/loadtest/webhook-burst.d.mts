export function signBody(body: string, secret: string): string;
export function percentile(sorted: number[], p: number): number;
export function rateAt(t: number, rps: number, duration: number): number;
export function run(opts: {
  url: string;
  secret: string;
  rps: number;
  duration: number;
  storeId: number;
  statusUrl?: string;
}): Promise<{
  sent: number;
  stats: { latencies: number[]; s2xx: number; s4xx: number; s5xx: number; other: number; errors: number };
  percentiles: { p50: number; p95: number; p99: number };
  drain: { measured: boolean; seconds?: number; pending?: number };
  failures: string[];
}>;
