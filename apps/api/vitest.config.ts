import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // NOTE: this suite used to run with `fileParallelism: false`, on the theory
    // that the intermittent parallel failures came from state shared across test
    // files. Measurement said otherwise: every failure was `Test timed out in
    // 5000ms`, never a wrong value, and the affected files pass alone *and* fail
    // when run concurrently with nothing but each other — which rules out any
    // particular file's leftovers as the cause. They each `await import()` a
    // large route module, and with 12 workers on 12 cores that evaluation lost
    // the race against vitest's 5s default. Raising only the timeout, changing
    // nothing else, took a reproducing set from 8 failures to 0.
    //
    // The fix is per-file (`vi.setConfig`) on the handful of import-heavy files
    // rather than a global bump, so a genuine hang anywhere else still fails in
    // 5s instead of stalling the run. Parallel is ~2.8x faster: 282s -> ~100s.
    coverage: {
      provider: 'v8',
      // Coverage is an on-demand diagnostic, not a merge gate. CI requires the
      // behavior tests themselves; it does not block on a repository-wide
      // percentage that can reward shallow tests and makes the suite materially
      // slower.
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      // `src/db/migrations/**` is defensive: generated migrations live in
      // apps/api/drizzle/ today, but should any land under src/ they must not
      // enter the coverage denominator and distort the report.
      exclude: ['src/**/__tests__/**', 'src/db/migrations/**', 'src/test/**'],
    },
  },
})
