import type { BlockProps } from './types';

/** プレーンのみ。改行は残す。Markdown・リンク化はしない */
export function TextBlock({ block }: BlockProps<'text'>) {
  return <p className="whitespace-pre-line break-words text-sm leading-relaxed text-secondary">{block.text}</p>;
}
