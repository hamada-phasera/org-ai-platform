import type { ReactNode } from 'react';

/**
 * 依存ライブラリ無しの軽量 Markdown レンダラ（チャット表示用）。
 * 対応: 見出し(#)、太字(**)、斜体(*,_)、インラインコード(`)、箇条書き(-,*,・)、番号付き、リンク([text](url)・素のURL)。
 * raw HTML は一切描画しない（XSS安全）。URL は https?:// のみリンク化。
 */

let keyCounter = 0;
function k(): number {
  keyCounter += 1;
  return keyCounter;
}

const INLINE_RE =
  /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(https?:\/\/[^\s)]+)/g;

function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      nodes.push(<strong key={k()}>{m[2]}</strong>);
    } else if (m[3]) {
      nodes.push(
        <code key={k()} className="rounded bg-black/5 px-1 py-0.5 text-[0.85em]">
          {m[4]}
        </code>,
      );
    } else if (m[5]) {
      nodes.push(
        <a key={k()} href={m[7]} target="_blank" rel="noopener noreferrer" className="text-accent underline break-all">
          {m[6]}
        </a>,
      );
    } else if (m[8]) {
      nodes.push(<em key={k()}>{m[9]}</em>);
    } else if (m[10]) {
      nodes.push(<em key={k()}>{m[11]}</em>);
    } else if (m[12]) {
      nodes.push(
        <a key={k()} href={m[12]} target="_blank" rel="noopener noreferrer" className="text-accent underline break-all">
          {m[12]}
        </a>,
      );
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = (text ?? '').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
    const isBullet = /^\s*[-*・]\s+/.test(line);
    const isNumbered = /^\s*\d+\.\s+/.test(line);

    if (heading) {
      blocks.push(
        <p key={k()} className="mb-0.5 mt-2 font-bold text-primary">
          {renderInline(heading[2])}
        </p>,
      );
      i += 1;
      continue;
    }

    if (isBullet || isNumbered) {
      const ordered = isNumbered && !isBullet;
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const b = lines[i].match(/^\s*[-*・]\s+(.*)$/);
        const n = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (!b && !n) break;
        items.push(<li key={k()}>{renderInline((b?.[1] ?? n?.[1]) ?? '')}</li>);
        i += 1;
      }
      blocks.push(
        ordered ? (
          <ol key={k()} className="my-1 list-decimal space-y-0.5 pl-5">
            {items}
          </ol>
        ) : (
          <ul key={k()} className="my-1 list-disc space-y-0.5 pl-5">
            {items}
          </ul>
        ),
      );
      continue;
    }

    if (line.trim() === '') {
      blocks.push(<div key={k()} className="h-2" />);
      i += 1;
      continue;
    }

    blocks.push(
      <p key={k()} className="my-0.5 whitespace-pre-wrap">
        {renderInline(line)}
      </p>,
    );
    i += 1;
  }

  return <div className="text-sm leading-relaxed text-[#2D2D2D]">{blocks}</div>;
}
