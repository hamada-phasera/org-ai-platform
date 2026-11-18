/**
 * ブロックの振り分け（許可リスト 7 種）。**知らない type は何も描かない**（定義が新しくて web が古いときに壊れない）。
 * 文字はすべてテキストノード。HTML を差し込む API・定義から来るスタイルや URL は使わない（設計書 §7.2・T4）。
 */
import type { PageBlock } from '@org-ai/shared-types';
import { HeadingBlock } from './blocks/HeadingBlock';
import { TextBlock } from './blocks/TextBlock';
import { KpiBlock } from './blocks/KpiBlock';
import { TableBlock } from './blocks/TableBlock';
import { ListBlock } from './blocks/ListBlock';
import { FormBlock } from './blocks/FormBlock';
import { ButtonsBlock } from './blocks/ButtonsBlock';

export function BlockRenderer({ block, index }: { block: PageBlock; index: number }) {
  switch (block.type) {
    case 'heading':
      return <HeadingBlock block={block} index={index} />;
    case 'text':
      return <TextBlock block={block} index={index} />;
    case 'kpi':
      return <KpiBlock block={block} index={index} />;
    case 'table':
      return <TableBlock block={block} index={index} />;
    case 'list':
      return <ListBlock block={block} index={index} />;
    case 'form':
      return <FormBlock block={block} index={index} />;
    case 'buttons':
      return <ButtonsBlock block={block} index={index} />;
    default:
      return null;
  }
}

/** 描画するブロックか（知らない type は区切り線ごと出さない） */
export function isKnownBlock(block: { type?: unknown }): boolean {
  return ['heading', 'text', 'kpi', 'table', 'list', 'form', 'buttons'].includes(String(block.type));
}
