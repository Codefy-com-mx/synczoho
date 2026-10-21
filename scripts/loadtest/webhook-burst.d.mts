export function signBody(body: string, secret: string): string;
export function percentile(sorted: number[], p: number): number;
export function parseArgs(argv: string[]): Record<string, string | true>;
export function parseOrderIds(raw: string | undefined | null): number[];
export function validateRates(rps: number, duration: number): string | null;
export function buildEvent(
  storeId: number,
  orderIds: number[],
  r?: number,
  pick?: () => number,
): { store_id: number; event: "product/updated" | "order/paid"; id: number };
export function verdictLine(failures: string[], drain: { measured: boolean; seconds?: number }): string;
export function rateAt(t: number, rps: number, duration: number): number;
export function run(opts: {
  url: string;
  secret: string;
  rps: number;
  duration: number;
  storeId: number;
  orderIds?: number[];
  noDrain?: boolean;
  statusUrl?: string;
}): Promise<{
  sent: number;
  stats: { latencies: number[]; s2xx: number; s4xx: number; s5xx: number; other: number; errors: number };
  percentiles: { p50: number; p95: number; p99: number };
  drain: { measured: boolean; skipped?: boolean; seconds?: number; pending?: number };
  failures: string[];
}>;
