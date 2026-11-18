import type { PageBlock } from '@org-ai/shared-types';

export type BlockOf<T extends PageBlock['type']> = Extract<PageBlock, { type: T }>;

export interface BlockProps<T extends PageBlock['type']> {
  block: BlockOf<T>;
  index: number;
}
