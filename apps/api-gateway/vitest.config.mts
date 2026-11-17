import { configDefaults, defineConfig } from 'vitest/config';

// 単体テスト（npm test）。DB・外部 API はモック。
// 実 Postgres を使う統合テスト（tests/integration）は `npm run test:int`（vitest.integration.config.mts）だけで回す。
// TEST_DATABASE_URL が手元に入っていても、npm test は DB に触らない。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/integration/**'],
  },
});
