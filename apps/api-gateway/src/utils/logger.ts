// 小さなロガー。`[scope] メッセージ` の形で console に出す（Render のログにそのまま流れる）。
//
// ■ なぜ console を包むだけか
//   出力の文言・形式を移行前と完全に同じに保つため（運用で grep しているタグを壊さない）。
//   出力先を pino 等に替えるときは、このファイルだけを直せばよい。
// ■ console はその都度参照する（握り込まない）。テストが vi.spyOn(console, ...) で差し替えるため。

type LogArgs = unknown[];

export interface Logger {
  info(message: string, ...args: LogArgs): void;
  warn(message: string, ...args: LogArgs): void;
  error(message: string, ...args: LogArgs): void;
}

/** `scope` を付けたロガーを作る。出力は `[scope] message ...args`。 */
export function createLogger(scope: string): Logger {
  const prefix = (message: string): string => `[${scope}] ${message}`;
  return {
    info: (message, ...args) => console.log(prefix(message), ...args),
    warn: (message, ...args) => console.warn(prefix(message), ...args),
    error: (message, ...args) => console.error(prefix(message), ...args),
  };
}

/**
 * ログに載せる用のエラー表現。Error ならメッセージだけ、それ以外は値そのもの
 * （スタックや内部の詳細をログに撒かないための従来の `e instanceof Error ? e.message : e`）。
 */
export function errorMessage(e: unknown): unknown {
  return e instanceof Error ? e.message : e;
}
