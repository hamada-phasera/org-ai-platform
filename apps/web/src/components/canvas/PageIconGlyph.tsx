import { createElement } from 'react';
import type { LucideProps } from 'lucide-react';
import { pageIconOf } from '../pages/icons';

/** 許可リストのアイコン名を lucide で描く（知らない名前は既定のアイコン）。描画中にコンポーネントを作らないための薄い包み */
export function PageIconGlyph({ name, ...props }: { name: string } & LucideProps) {
  return createElement(pageIconOf(name), props);
}
