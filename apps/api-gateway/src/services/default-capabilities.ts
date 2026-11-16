// 新しい組織に最初から入れておくノード（Capability）の一覧。
//
// ■ 使うところ
//   * 組織の作成（POST /api/auth/register, POST /api/organizations）… seedDefaultCapabilities
//   * 既存組織への手動投入 … packages/db-schema/prisma/seed-capabilities.ts（ここを import する）
// 以前は seed スクリプトにだけあり、新しい組織が「ノードが1つも無い」状態で始まっていた（設計書 E8）。
//
// ⚠️ DB に依存しない純粋なデータ。Prisma の enum 型も使わない（seed スクリプトからも読むため）。

export type DefaultCapability = {
  name: string;
  displayName: string;
  description: string;
  department: string;
  inputSchema: Record<string, unknown>;
  webhookPath: string;
  status: 'ACTIVE' | 'NEEDS_AUTH';
  providers: string[];
};

export const DEFAULT_CAPABILITIES: DefaultCapability[] = [
  {
    name: 'draft_email',
    displayName: 'メール下書き作成',
    description: '営業メール / ビジネスメールの本文を下書きする。送信はしない。受信先のヒントと目的から件名と本文を生成。',
    department: 'SALES',
    inputSchema: {
      type: 'object',
      required: ['recipientHint', 'purpose'],
      properties: {
        recipientHint: { type: 'string', description: '誰宛か (顧客名 / 役職)' },
        purpose: { type: 'string', description: 'メールの目的・要件' },
        toneHint: { type: 'string', description: '丁寧 / カジュアル / 強気 など', nullable: true },
      },
      additionalProperties: false,
    },
    webhookPath: 'cap-draft_email',
    status: 'ACTIVE',
    providers: [],
  },
  {
    name: 'send_email',
    displayName: 'メール送信',
    description: '指定された宛先・件名・本文でメールを実送信する。Gmail 接続が必要。',
    department: 'SALES',
    inputSchema: {
      type: 'object',
      required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'string', format: 'email' },
        subject: { type: 'string' },
        body: { type: 'string' },
        cc: { type: 'string', nullable: true },
      },
      additionalProperties: false,
    },
    webhookPath: 'cap-send_email',
    status: 'NEEDS_AUTH',
    providers: ['gmail'],
  },
  {
    name: 'post_to_x',
    displayName: 'X (Twitter) 投稿',
    description: 'X (旧 Twitter) にツイートを投稿する。X API 接続が必要。',
    department: 'MARKETING',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', maxLength: 280 },
      },
      additionalProperties: false,
    },
    webhookPath: 'cap-post_to_x',
    status: 'NEEDS_AUTH',
    providers: ['x'],
  },
  {
    name: 'summarize_sheet',
    displayName: 'Googleスプレッドシート要約',
    description: '指定 ID の Google スプレッドシートを読んで内容を要約する。',
    department: 'ANALYTICS',
    inputSchema: {
      type: 'object',
      required: ['sheetId'],
      properties: {
        sheetId: { type: 'string' },
        range: { type: 'string', nullable: true },
      },
      additionalProperties: false,
    },
    webhookPath: 'cap-summarize_sheet',
    status: 'NEEDS_AUTH',
    providers: ['google_sheets'],
  },
  {
    name: 'notify_slack',
    displayName: 'Slack 投稿',
    description: '指定チャンネルへ Slack メッセージを投稿する。チャットで要件が固まった内容を成果物として投稿でき、管理者通知 / 未対応要望通知にも内部利用される。',
    department: 'GENERAL',
    inputSchema: {
      type: 'object',
      required: ['channel', 'text'],
      properties: {
        channel: { type: 'string', description: '#channel-name または チャンネル名' },
        text: { type: 'string', description: '投稿本文' },
      },
      additionalProperties: false,
    },
    webhookPath: 'cap-notify_slack',
    status: 'NEEDS_AUTH',
    providers: ['slack'],
  },
  {
    name: 'create_google_doc',
    displayName: 'Googleドキュメント作成',
    description: 'チャットで要件が固まった内容から Google ドキュメントを作成し、共有URLを返す。',
    department: 'GENERAL',
    inputSchema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title: { type: 'string', description: 'ドキュメントのタイトル' },
        content: { type: 'string', description: '本文（プレーンテキスト / マークダウン）' },
      },
      additionalProperties: false,
    },
    webhookPath: 'cap-create_google_doc',
    status: 'NEEDS_AUTH',
    // provider 文字列は n8n の credential type (googleDocsOAuth2Api 等) に substring 一致させる
    providers: ['googledocs'],
  },
  {
    name: 'create_google_sheet',
    displayName: 'Googleスプレッドシート作成',
    description: 'チャットで固まった表データから Google スプレッドシートを作成し、共有URLを返す。',
    department: 'ANALYTICS',
    inputSchema: {
      type: 'object',
      required: ['title', 'headers', 'rows'],
      properties: {
        title: { type: 'string', description: 'シートのタイトル' },
        headers: { type: 'array', items: { type: 'string' }, description: '列ヘッダー' },
        rows: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: '行データ（各行は文字列配列）',
        },
      },
      additionalProperties: false,
    },
    webhookPath: 'cap-create_google_sheet',
    status: 'NEEDS_AUTH',
    providers: ['googlesheets'],
  },
  {
    name: 'create_google_slides',
    displayName: 'Googleスライド作成',
    description: 'チャットで固まった構成から Google スライド（プレゼン）を作成し、共有URLを返す。',
    department: 'MARKETING',
    inputSchema: {
      type: 'object',
      required: ['title', 'slides'],
      properties: {
        title: { type: 'string', description: 'プレゼンのタイトル' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              content: { type: 'string' },
            },
          },
          description: '各スライドの見出しと内容',
        },
      },
      additionalProperties: false,
    },
    webhookPath: 'cap-create_google_slides',
    status: 'NEEDS_AUTH',
    providers: ['googleslides'],
  },
];
