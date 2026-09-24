import pg, { type PoolConfig } from "pg";

const { Pool } = pg;

export interface QueryError {
  message: string;
  code?: string;
  details?: string;
}

export interface QueryResult {
  // The compatibility layer mirrors the dynamic row typing of the old API.
  // Domain-specific validation remains in each handler.
  data: any;
  error: QueryError | null;
  count: number | null;
}

type Row = Record<string, unknown>;
type Operation = "select" | "insert" | "update" | "upsert" | "delete";
type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "or"; expression: string };

function identifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function selectedColumns(value: string): string {
  if (value.trim() === "*") return "*";
  return value
    .split(",")
    .map((column) => identifier(column.trim()))
    .join(", ");
}

function normalizeRows(value: Row | Row[]): Row[] {
  return Array.isArray(value) ? value : [value];
}

function databaseError(error: unknown): QueryError {
  const candidate = error as { message?: string; code?: string; detail?: string };
  return {
    message: candidate?.message || "Database query failed",
    code: candidate?.code,
    details: candidate?.detail,
  };
}

export class QueryBuilder implements PromiseLike<QueryResult> {
  private operation: Operation = "select";
  private columns = "*";
  private values: Row[] = [];
  private filters: Filter[] = [];
  private ordering: { column: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private single = false;
  private head = false;
  private countMode = false;
  private conflictColumns: string[] = [];

  constructor(
    private readonly pool: pg.Pool,
    private readonly table: string,
  ) {
    identifier(table);
  }

  select(columns = "*", options?: { count?: "exact"; head?: boolean }): this {
    this.columns = columns;
    this.countMode = options?.count === "exact";
    this.head = options?.head === true;
    return this;
  }

  insert(values: Row | Row[]): this {
    this.operation = "insert";
    this.values = normalizeRows(values);
    return this;
  }

  update(values: Row): this {
    this.operation = "update";
    this.values = [values];
    return this;
  }

  upsert(values: Row | Row[], options?: { onConflict?: string }): this {
    this.operation = "upsert";
    this.values = normalizeRows(values);
    this.conflictColumns = (options?.onConflict || "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    return this;
  }

  delete(): this {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push({ kind: "in", column, values });
    return this;
  }

  or(expression: string): this {
    this.filters.push({ kind: "or", expression });
    return this;
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(value: number): this {
    this.rowLimit = Math.max(0, Math.trunc(value));
    return this;
  }

  maybeSingle(): this {
    this.single = true;
    this.rowLimit = 2;
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private whereClause(parameters: unknown[]): string {
    if (this.filters.length === 0) return "";
    const parts = this.filters.map((filter) => {
      if (filter.kind === "eq") {
        parameters.push(filter.value);
        return `${identifier(filter.column)} = $${parameters.length}`;
      }
      if (filter.kind === "in") {
        if (filter.values.length === 0) return "FALSE";
        const placeholders = filter.values.map((value) => {
          parameters.push(value);
          return `$${parameters.length}`;
        });
        return `${identifier(filter.column)} IN (${placeholders.join(", ")})`;
      }

      const clauses = filter.expression.split(",").map((raw) => {
        const match = raw.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq)\.(.+)$/);
        if (!match) throw new Error(`Unsupported OR expression: ${raw}`);
        parameters.push(match[3]);
        return `${identifier(match[1])} ${match[2] === "eq" ? "=" : "<>"} $${parameters.length}`;
      });
      return `(${clauses.join(" OR ")})`;
    });
    return ` WHERE ${parts.join(" AND ")}`;
  }

  private async execute(): Promise<QueryResult> {
    try {
      const parameters: unknown[] = [];
      const table = identifier(this.table);
      let sql: string;

      if (this.operation === "select") {
        const where = this.whereClause(parameters);
        if (this.countMode && this.head) {
          const result = await this.pool.query(`SELECT COUNT(*)::int AS count FROM ${table}${where}`, parameters);
          return { data: null, error: null, count: Number(result.rows[0]?.count || 0) };
        }

        sql = `SELECT ${selectedColumns(this.columns)} FROM ${table}${where}`;
        if (this.ordering) {
          sql += ` ORDER BY ${identifier(this.ordering.column)} ${this.ordering.ascending ? "ASC" : "DESC"}`;
        }
        if (this.rowLimit !== null) sql += ` LIMIT ${this.rowLimit}`;
      } else if (this.operation === "delete") {
        sql = `DELETE FROM ${table}${this.whereClause(parameters)} RETURNING *`;
      } else if (this.operation === "update") {
        const row = this.values[0] || {};
        const assignments = Object.entries(row).map(([column, value]) => {
          parameters.push(value);
          return `${identifier(column)} = $${parameters.length}`;
        });
        if (assignments.length === 0) return { data: [], error: null, count: 0 };
        sql = `UPDATE ${table} SET ${assignments.join(", ")}${this.whereClause(parameters)} RETURNING *`;
      } else {
        if (this.values.length === 0) return { data: [], error: null, count: 0 };
        const columns = [...new Set(this.values.flatMap((row) => Object.keys(row)))];
        const tuples = this.values.map((row) => {
          const placeholders = columns.map((column) => {
            parameters.push(row[column] === undefined ? null : row[column]);
            return `$${parameters.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        sql = `INSERT INTO ${table} (${columns.map(identifier).join(", ")}) VALUES ${tuples.join(", ")}`;
        if (this.operation === "upsert") {
          if (this.conflictColumns.length === 0) throw new Error("upsert requires onConflict");
          const conflict = this.conflictColumns.map(identifier).join(", ");
          const updates = columns
            .filter((column) => !this.conflictColumns.includes(column))
            .map((column) => `${identifier(column)} = EXCLUDED.${identifier(column)}`);
          sql += ` ON CONFLICT (${conflict}) ${updates.length ? `DO UPDATE SET ${updates.join(", ")}` : "DO NOTHING"}`;
        }
        sql += " RETURNING *";
      }

      const result = await this.pool.query(sql, parameters);
      const rows = result.rows;
      if (this.single) {
        if (rows.length > 1) {
          return { data: null, error: { message: "Expected at most one row" }, count: rows.length };
        }
        return { data: rows[0] || null, error: null, count: rows.length };
      }
      return { data: rows, error: null, count: this.countMode ? result.rowCount : null };
    } catch (error) {
      return { data: null, error: databaseError(error), count: null };
    }
  }
}

export class DatabaseClient {
  constructor(readonly pool: pg.Pool) {}

  from(table: string): QueryBuilder {
    return new QueryBuilder(this.pool, table);
  }
}

let pool: pg.Pool | null = null;
let database: DatabaseClient | null = null;
let lockPool: pg.Pool | null = null;

function poolConfig(max: number): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return {
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  };
}

export function getPool(): pg.Pool {
  if (pool) return pool;
  pool = new Pool(poolConfig(Math.max(2, Number(process.env.DB_POOL_SIZE || 10))));
  pool.on("error", (error) => console.error("Unexpected PostgreSQL pool error", error));
  return pool;
}

/**
 * Dedicated bounded pool for the per-(store, operation) session advisory
 * locks held by real stock/price runs.
 *
 * Keeping lock connections out of the main data pool prevents a long run from
 * starving handler queries, including a DB_POOL_SIZE=1 deployment, and lets
 * DB_POOL_SIZE size only the data workload. The lock pool is still bounded:
 * when every lock connection is held, `pg.Pool.connect()` waits up to
 * `connectionTimeoutMillis` and then rejects, so a request fails instead of
 * overlapping another run. No pool can guarantee a live lock forever: if a
 * database connection dies mid-run, PostgreSQL releases the session lock once
 * it notices the dead connection, and until then a competing run is skipped.
 */
export function getLockPool(): pg.Pool {
  if (lockPool) return lockPool;
  lockPool = new Pool(poolConfig(Number(process.env.DB_LOCK_POOL_SIZE || 4)));
  lockPool.on("error", (error) => console.error("Unexpected PostgreSQL lock pool error", error));
  return lockPool;
}

export function getDatabase(): DatabaseClient {
  if (!database) database = new DatabaseClient(getPool());
  return database;
}

export async function closeDatabase(): Promise<void> {
  const data = pool;
  const locks = lockPool;
  pool = null;
  database = null;
  lockPool = null;
  // End both pools even when one of them fails to close.
  await Promise.all([data?.end(), locks?.end()]);
}
