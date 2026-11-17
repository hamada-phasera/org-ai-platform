/**
 * 公開の法務 3 頁（利用規約・プライバシーポリシー・特定商取引法に基づく表記）の骨組み。
 *
 * ⚠️ 文面はここで書かない（計画書 O-7: 文面と事業者情報はオーナーが入れる）。
 * 置くのは見出しと項目名だけで、内容は `null` = 未記入として画面に明示する。
 * 埋めるときは `value` に文字列を入れるだけ。見出しを足すときは行を足す。
 */
export interface LegalRow {
  label: string;
  /** null は未記入（画面に「未記入」と出す） */
  value: string | null;
}

export interface LegalSection {
  heading: string;
  rows: LegalRow[];
}

export interface LegalDoc {
  path: string;
  /** リンクの一語ラベル */
  short: string;
  title: string;
  updatedAt: string | null;
  sections: LegalSection[];
}

const blank = (...labels: string[]): LegalRow[] => labels.map((label) => ({ label, value: null }));

export const TERMS: LegalDoc = {
  path: '/legal/terms',
  short: '規約',
  title: '利用規約',
  updatedAt: null,
  sections: [
    { heading: '総則', rows: blank('適用', '定義', '規約の変更') },
    { heading: '契約', rows: blank('登録', '無料期間', '料金と支払い', '解約', '解約後のデータ') },
    { heading: '利用', rows: blank('禁止事項', 'AI の出力の扱い', '外部サービスとの連携', '利用の停止') },
    { heading: '責任', rows: blank('保証の否認', '責任の制限', '損害賠償') },
    { heading: 'その他', rows: blank('権利の帰属', '譲渡の禁止', '準拠法', '管轄裁判所') },
  ],
};

export const PRIVACY: LegalDoc = {
  path: '/legal/privacy',
  short: 'プライバシー',
  title: 'プライバシーポリシー',
  updatedAt: null,
  sections: [
    { heading: '事業者', rows: blank('名称', '所在地', '代表者', '窓口') },
    { heading: '取得', rows: blank('取得する情報', '取得の方法') },
    { heading: '利用', rows: blank('利用目的', 'AI への送信', '保存期間') },
    { heading: '提供', rows: blank('第三者提供', '委託先', '外国にある第三者への提供') },
    { heading: '管理', rows: blank('安全管理措置', '開示・訂正・削除の請求', '改定') },
  ],
};

export const TOKUSHOHO: LegalDoc = {
  path: '/legal/tokushoho',
  short: '特商法',
  title: '特定商取引法に基づく表記',
  updatedAt: null,
  sections: [
    {
      heading: '事業者',
      rows: blank('販売事業者', '運営統括責任者', '所在地', '電話番号', 'メールアドレス', '登録番号'),
    },
    {
      heading: '取引',
      rows: blank(
        '販売価格',
        '商品代金以外の必要料金',
        '支払方法',
        '支払時期',
        '提供時期',
        '返品・キャンセル',
        '解約',
        '動作環境',
      ),
    },
  ],
};

/** フッターなどに並べる順 */
export const LEGAL_DOCS: readonly LegalDoc[] = [TERMS, PRIVACY, TOKUSHOHO];
