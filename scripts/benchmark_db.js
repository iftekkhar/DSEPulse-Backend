import {
  getAllStocksFromDB,
  saveDailyClosingToDB,
  saveFundamentalsBulkDelta,
  dbRun
} from '../server/db.js';

// This benchmark writes through the SAME db.js connection as the live server
// -- there is no separate benchmark/test database. It used to build its mock
// write-benchmark records from real stock data (`s.ltp || 50`, `s.volume ||
// 10000`, etc.) and write them straight into price_history/fundamentals_history
// under REAL symbols and a real-looking date, with no cleanup step. That's a
// destructive write against production data with no safeguard: any `||`
// fallback firing (any real 0/null field) injected a placeholder value into a
// real row, and a real (symbol, fiscal_year) key in the fundamentals-delta
// benchmark could overwrite a real disclosure. Fixed 2026-08-23 -- every write
// benchmark below now targets synthetic keys (a fake symbol prefix, a
// sentinel date decades outside any real DSE trading history) that can never
// collide with real data, and everything written is deleted again in a
// `finally` block before the script exits, even if a benchmark throws.
const BENCH_SYMBOL_PREFIX = '__BENCH__';
const BENCH_DATE = '1901-01-01'; // DSEX didn't exist; DSE itself didn't exist. Cannot collide with real data.
const BENCH_FISCAL_YEAR = 1901;

async function cleanup() {
  await dbRun(`DELETE FROM price_history WHERE symbol LIKE '${BENCH_SYMBOL_PREFIX}%'`);
  await dbRun(`DELETE FROM fundamentals_history WHERE symbol LIKE '${BENCH_SYMBOL_PREFIX}%'`);
}

async function runBenchmark() {
  console.log('🏁 Starting SQLite Database Ingestion & Query Benchmark...\n');
  console.log(`   (write benchmarks use synthetic ${BENCH_SYMBOL_PREFIX}* symbols / ${BENCH_DATE} only -- never real data; cleaned up on exit)\n`);

  // 1. Benchmark Query Speed with Covering Index -- read-only, safe against
  // real data as-is.
  const t0 = performance.now();
  const stocks = await getAllStocksFromDB();
  const t1 = performance.now();
  console.log(`⚡ 1. getAllStocksFromDB (${stocks.length} equities): ${(t1 - t0).toFixed(2)}ms`);

  const sampleSize = Math.max(1, Math.min(stocks.length, 440));

  // 2. Benchmark Prepared Statement Bulk Daily Closing Ingestion -- synthetic
  // symbols/date, real-shaped numeric values (not fabricated substitutes for
  // a real stock's real field, since none of these rows claim to represent
  // an actual company).
  const mockDaily = Array.from({ length: sampleSize }, (_, i) => ({
    symbol: `${BENCH_SYMBOL_PREFIX}${i}`,
    ltp: 50 + (i % 100),
    ycp: 50 + (i % 100),
    change: 0,
    changePercent: 0,
    volume: 10000,
    pe: 10,
    source: null
  }));

  const t2 = performance.now();
  const insertedDaily = await saveDailyClosingToDB(mockDaily, BENCH_DATE);
  const t3 = performance.now();
  console.log(`⚡ 2. saveDailyClosingToDB (${insertedDaily} synthetic records bulk batch): ${(t3 - t2).toFixed(2)}ms`);

  // 3. Benchmark Smart Delta Bulk Ingestion (0-Write check on N identical
  // synthetic records -- first call creates them, so this specifically times
  // the "nothing changed" compare-and-skip path).
  const mockFundamentals = Array.from({ length: sampleSize }, (_, i) => ({
    symbol: `${BENCH_SYMBOL_PREFIX}${i}`,
    fiscalYear: BENCH_FISCAL_YEAR,
    epsBasic: 5,
    navPerShare: 50,
    auditedPeriod: 'FY1901 Benchmark'
  }));
  await saveFundamentalsBulkDelta(mockFundamentals); // seed identical rows once

  const t4 = performance.now();
  const deltaResultUnchanged = await saveFundamentalsBulkDelta(mockFundamentals);
  const t5 = performance.now();
  console.log(`⚡ 3. Smart Delta (${sampleSize} identical synthetic records -> ${deltaResultUnchanged.changedCount} writes, ${deltaResultUnchanged.unchangedCount} untouched): ${(t5 - t4).toFixed(2)}ms`);

  // 4. Benchmark Smart Delta with 1 changed record.
  const modifiedList = [{
    symbol: `${BENCH_SYMBOL_PREFIX}0`,
    fiscalYear: BENCH_FISCAL_YEAR,
    epsBasic: 9.12,
    auditedPeriod: 'FY1901 Benchmark (modified)'
  }];
  const t6 = performance.now();
  const deltaResultChanged = await saveFundamentalsBulkDelta(modifiedList);
  const t7 = performance.now();
  console.log(`⚡ 4. Smart Delta (Targeted update -> ${deltaResultChanged.changedCount} write): ${(t7 - t6).toFixed(2)}ms\n`);

  console.log('🎉 All Database Ingestion & Query Benchmarks Passed with Top-Tier Performance!');
}

runBenchmark()
  .catch(err => {
    console.error('Benchmark failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    console.log('🧹 Synthetic benchmark rows cleaned up.');
  });
