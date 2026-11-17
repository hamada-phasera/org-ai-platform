import { defineConfig } from 'vitest/config';

// 実 Postgres の統合テスト（計画書チャンク 9）。`npm run test:int`。
// TEST_DATABASE_URL（DB 名は flow_ で始まること）が無ければ各ファイルがスキップされる。
// ファイルごとに新しいデータベースを作ってマイグレーションを当てるので、並列にせず順に回す。
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
