// @vitest-environment jsdom
//
// 送信前の確認ダイアログ（レビュー L1）: 再描画でフォーカスが動かない・Tab がダイアログから抜けない・Escape で閉じる・閉じたら元へ戻る。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '../ConfirmDialog';

afterEach(cleanup);

function Host({ open, tick, onCancel }: { open: boolean; tick: number; onCancel: () => void }) {
  return (
    <div>
      <button type="button">背後</button>
      <span>{tick}</span>
      {/* 親が再描画されるたびに onCancel を作り直す（useSubmit と同じ書き方） */}
      {open && <ConfirmDialog message="送信しますか" onConfirm={() => {}} onCancel={() => onCancel()} />}
    </div>
  );
}

describe('ConfirmDialog', () => {
  it('開くと「やめる」にフォーカス。親が再描画されても「実行」に移したフォーカスは動かない', () => {
    const onCancel = vi.fn();
    const { rerender } = render(<Host open tick={0} onCancel={onCancel} />);
    const cancel = screen.getByRole('button', { name: 'やめる' });
    const confirm = screen.getByRole('button', { name: '実行' });
    expect(document.activeElement).toBe(cancel);
    confirm.focus();
    rerender(<Host open tick={1} onCancel={onCancel} />);
    rerender(<Host open tick={2} onCancel={onCancel} />);
    expect(document.activeElement).toBe(confirm);
  });

  it('Tab / Shift+Tab は 2 つのボタンの間で回り、背後に抜けない', () => {
    render(<Host open tick={0} onCancel={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const cancel = screen.getByRole('button', { name: 'やめる' });
    const confirm = screen.getByRole('button', { name: '実行' });
    confirm.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('Escape は最新の onCancel を呼び、閉じたら開く前の要素にフォーカスを戻す', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<Host open={false} tick={0} onCancel={first} />);
    const behind = screen.getByRole('button', { name: '背後' });
    behind.focus();
    rerender(<Host open tick={1} onCancel={first} />);
    rerender(<Host open tick={2} onCancel={latest} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    rerender(<Host open={false} tick={3} onCancel={latest} />);
    expect(document.activeElement).toBe(behind);
  });
});
