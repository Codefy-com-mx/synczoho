import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pools: [] as Array<{ options: any; ended: number }>,
}));

vi.mock("pg", () => {
  class FakePool {
    options: any;
    ended = 0;

    constructor(options: any) {
      this.options = options;
      h.pools.push(this);
    }

    on() {
      return this;
    }

    async end() {
      this.ended++;
    }
  }

  return { default: { Pool: FakePool } };
});

const originalEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_SSL: process.env.DATABASE_SSL,
  DB_POOL_SIZE: process.env.DB_POOL_SIZE,
  DB_LOCK_POOL_SIZE: process.env.DB_LOCK_POOL_SIZE,
};

function setEnv(name: keyof typeof originalEnv, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function loadDatabaseModule() {
  vi.resetModules();
  return await import("../../server/db");
}

beforeEach(() => {
  h.pools = [];
  setEnv("DATABASE_URL", "postgresql://user:password@127.0.0.1:5432/unit-test");
  setEnv("DATABASE_SSL", undefined);
  setEnv("DB_POOL_SIZE", undefined);
  setEnv("DB_LOCK_POOL_SIZE", undefined);
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    setEnv(name as keyof typeof originalEnv, value);
  }
});

describe("lock connection pool", () => {
  it("is a distinct bounded pool with its own size and connection settings", async () => {
    setEnv("DB_POOL_SIZE", "10");
    setEnv("DB_LOCK_POOL_SIZE", "4");
    setEnv("DATABASE_SSL", "true");
    const db = await loadDatabaseModule();

    const data = db.getPool();
    const lock = db.getLockPool();

    expect(lock).not.toBe(data);
    expect(h.pools).toHaveLength(2);
    expect(h.pools[0].options.max).toBe(10);
    expect(h.pools[1].options.max).toBe(4);
    expect(h.pools[1].options.connectionString).toBe(h.pools[0].options.connectionString);
    expect(h.pools[1].options.ssl).toEqual({ rejectUnauthorized: false });
    expect(db.getLockPool()).toBe(lock);
    expect(h.pools).toHaveLength(2);
  });

  it("keeps its own default when the data pool is size one", async () => {
    setEnv("DB_POOL_SIZE", "1");
    const db = await loadDatabaseModule();

    db.getPool();
    db.getLockPool();

    expect(h.pools[0].options.max).toBe(1);
    expect(h.pools[1].options.max).toBe(4);
  });

  it("closes the lock pool together with the data pool", async () => {
    const db = await loadDatabaseModule();
    db.getPool();
    const lock = db.getLockPool();

    await db.closeDatabase();

    expect(h.pools).toHaveLength(2);
    expect(h.pools[0].ended).toBe(1);
    expect(h.pools[1].ended).toBe(1);
    expect(db.getLockPool()).not.toBe(lock);
    expect(h.pools).toHaveLength(3);
  });

  it("requires the database URL before creating the lock pool", async () => {
    setEnv("DATABASE_URL", undefined);
    const db = await loadDatabaseModule();

    expect(() => db.getLockPool()).toThrow("DATABASE_URL is required");
    expect(h.pools).toHaveLength(0);
  });
});
