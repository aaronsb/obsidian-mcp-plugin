module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.ts',
    '**/?(*.)+(spec|test).ts'
  ],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/main.ts' // Exclude main plugin entry point from coverage
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],

  // Ratchet, not a target. Each floor sits just under the measured value at the time
  // it was set, so it blocks backslide without blocking work. Raise a floor when real
  // coverage clears it — never lower one to make a run go green.
  //
  // Jest subtracts glob-matched paths from the global pool, so `global` below is the
  // residual (everything except the security/ and validation/ globs), which is why it
  // reads lower than the headline number `make coverage` prints.
  //
  // Directory keys (trailing slash) are aggregate floors across the files beneath them.
  // A glob key would instead apply the floor to each file individually — a much harsher
  // gate that today's numbers cannot clear. Tightening these to per-file globs is the
  // natural next ratchet once the weak files (secure-obsidian-api, mcp-ignore-manager)
  // come up.
  //
  // Measured 2026-07-13 (baseline: statements 38.57 overall).
  coverageThreshold: {
    // Security boundary: .mcpignore matching, path validation, TLS. Held highest —
    // a silent regression here exposes vault content rather than merely breaking a call.
    './src/security/': {
      statements: 75, branches: 66, functions: 65, lines: 76
    },
    './src/validation/': {
      statements: 82, branches: 79, functions: 95, lines: 83
    },
    global: {
      statements: 35, branches: 28, functions: 36, lines: 35
    }
  },
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    '^obsidian$': '<rootDir>/tests/__mocks__/obsidian.ts'
  },
  testTimeout: 10000
};