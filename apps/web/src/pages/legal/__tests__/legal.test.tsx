import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import App from '../../../App';
import { LEGAL_DOCS, PRIVACY, TERMS, TOKUSHOHO } from '../content';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function renderAt(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('法務の 3 頁', () => {
  // 静的描画（renderToStaticMarkup）は zustand の初期状態（未ログイン）を読む
  it.each(LEGAL_DOCS.map((d) => [d.path, d] as const))('%s は未ログインで開ける', (path, doc) => {
    const html = renderAt(path);
    expect(html).toContain(`<h1`);
    expect(html).toContain(doc.title);
    for (const s of doc.sections) {
      expect(html).toContain(s.heading);
      for (const r of s.rows) expect(html).toContain(r.label);
    }
    // ログイン画面に飛ばされていない
    expect(html).not.toContain('アカウントにサインインする');
  });

  it('比較: シェル配下は未ログインだと何も描かずログインへ飛ぶ（Navigate）', () => {
    expect(renderAt('/settings')).toBe('');
  });

  it('未記入の項目は「未記入」と明示する（空欄のまま公開しない）', () => {
    const html = renderAt(TOKUSHOHO.path);
    const rows = TOKUSHOHO.sections.flatMap((s) => s.rows);
    const blanks = rows.filter((r) => r.value === null).length;
    expect(blanks).toBeGreaterThan(0);
    // 行の数 + 更新日
    expect(html.match(/未記入/g)?.length).toBe(blanks + (TOKUSHOHO.updatedAt ? 0 : 1));
  });

  it('特商法の表に必須の項目がある', () => {
    const labels = TOKUSHOHO.sections.flatMap((s) => s.rows.map((r) => r.label));
    for (const l of ['販売事業者', '所在地', '電話番号', '販売価格', '支払方法', '支払時期', '提供時期', '返品・キャンセル']) {
      expect(labels).toContain(l);
    }
  });

  it('各頁から他の 2 頁へのリンクがある', () => {
    for (const doc of [TERMS, PRIVACY, TOKUSHOHO]) {
      const html = renderAt(doc.path);
      for (const other of LEGAL_DOCS) expect(html).toContain(`href="${other.path}"`);
    }
  });
});

describe('法務の頁へのリンク', () => {
  it.each([
    ['登録', '../../RegisterPage.tsx'],
    ['ログイン', '../../LoginPage.tsx'],
    ['契約', '../../../components/Settings/BillingSection.tsx'],
  ])('%s画面に LegalLinks がある', (_name, rel) => {
    const src = read(rel);
    expect(src).toMatch(/import \{ LegalLinks \} from '[./]+(pages\/)?legal\/LegalLinks'/);
    expect(src).toContain('<LegalLinks');
  });

  it('登録画面のリンクは描画される', () => {
    const html = renderAt('/register');
    for (const d of LEGAL_DOCS) expect(html).toContain(`href="${d.path}"`);
  });
});
