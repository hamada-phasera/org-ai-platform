// 走行中のバックグラウンド処理の在庫台帳。prisma / fastify を import しない（テストしやすさのため）。
//
// なぜ要るか:
//   このアプリは HTTP の返事を返したあとも裏で走り続ける処理を持つ
//   （エージェント実行・承認後の再開・RAG索引・領収書読み取り・返信下書き）。
//   Render はデプロイのたびに SIGTERM を送って古いプロセスを落とすので、
//   何が走っているかを知らないと、途中で切れたことにすら気づけない。

/** 追跡する処理の種類。終了時の後始末が種類ごとに違う。 */
export type JobKind =
  | 'agent-run'      // Task を持つ。中断したら FAILED を打てる
  | 'agent-resume'   // 同上（承認後の続き）
  | 'file-index'     // Task を持たない。失っても再アップロードで直る
  | 'receipt'        // Task を持たない。InboundMessage に印を付けたい
  | 'inbox-draft';   // 同上

export interface JobRecord {
  id: number;
  kind: JobKind;
  /** 後始末に使う識別子（taskId や inboundMessageId） */
  ref: string | null;
  startedAt: number;
}

/**
 * 在庫台帳。
 *
 * ⚠️ プロセス内のメモリなので、複数インスタンスでは各自の分しか知らない。
 *    それで正しい（自分が殺されるときに自分の分を片付けるための台帳なので）。
 */
export class JobRegistry {
  private seq = 0;
  private jobs = new Map<number, JobRecord>();
  private draining = false;

  /** 新規受付を止めたか。止めたあとの track は false を返す。 */
  get isDraining(): boolean {
    return this.draining;
  }

  get size(): number {
    return this.jobs.size;
  }

  list(): JobRecord[] {
    return [...this.jobs.values()];
  }

  listByKind(kinds: readonly JobKind[]): JobRecord[] {
    return this.list().filter((j) => kinds.includes(j.kind));
  }

  /**
   * 処理の開始を記録する。戻り値を finish に渡す。
   * 終了処理が始まっていたら null を返す（呼び出し側は開始しない判断ができる）。
   */
  start(kind: JobKind, ref: string | null, now: number): number | null {
    if (this.draining) return null;
    const id = ++this.seq;
    this.jobs.set(id, { id, kind, ref, startedAt: now });
    return id;
  }

  finish(id: number | null): void {
    if (id !== null) this.jobs.delete(id);
  }

  /** 新規受付を止める。以降 start は null を返す。 */
  beginShutdown(): void {
    this.draining = true;
  }

  /** テスト用。 */
  reset(): void {
    this.jobs.clear();
    this.seq = 0;
    this.draining = false;
  }
}

export interface DrainOptions {
  /** 待つ上限（ms） */
  budgetMs: number;
  /** 確認間隔（ms） */
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 待たずに即座に諦める種類（長時間かかるもの） */
  skipKinds?: readonly JobKind[];
}

export interface DrainResult {
  /** 予算内に終わったか */
  drained: boolean;
  /** 待ちきれずに残った処理 */
  remaining: JobRecord[];
  waitedMs: number;
}

/**
 * 走行中の処理が終わるのを、予算いっぱいまで待つ。
 *
 * ⚠️ 待つのは「短時間で終わるはずのもの」だけ。エージェント実行のように分単位で
 *    かかりうるものを待つと、Render の猶予を使い切って結局強制終了される。
 *    そういう種類は skipKinds に入れ、待たずに「中断された」と記録する。
 */
export async function drain(registry: JobRegistry, opts: DrainOptions): Promise<DrainResult> {
  const started = opts.now();
  const skip = opts.skipKinds ?? [];
  const waitable = (): JobRecord[] => registry.list().filter((j) => !skip.includes(j.kind));

  while (waitable().length > 0) {
    if (opts.now() - started >= opts.budgetMs) {
      return { drained: false, remaining: waitable(), waitedMs: opts.now() - started };
    }
    await opts.sleep(opts.pollMs);
  }
  return { drained: true, remaining: [], waitedMs: opts.now() - started };
}

/** プロセス全体で共有する台帳。 */
export const jobs = new JobRegistry();

/**
 * バックグラウンド処理を台帳に載せて走らせる。
 *
 * これを通さずに `void something()` すると、終了時に「走っていたこと」すら
 * 分からないので、必ずこれを使うこと。
 */
export function tracked<T>(
  kind: JobKind,
  ref: string | null,
  run: () => Promise<T>,
  registry: JobRegistry = jobs,
): void {
  const id = registry.start(kind, ref, Date.now());
  /* 終了処理が始まっていたら新規に走らせない。走らせても途中で殺されるだけで、
     「中断された」記録だけが増える */
  if (id === null) {
    console.warn(`[lifecycle] 終了処理中のため ${kind} を開始しませんでした`);
    return;
  }
  void run()
    .catch((e) => {
      console.error(`[lifecycle] ${kind} が失敗:`, e instanceof Error ? e.message : e);
    })
    .finally(() => registry.finish(id));
}
