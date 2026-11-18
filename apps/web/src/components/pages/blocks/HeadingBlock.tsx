import type { BlockProps } from './types';

export function HeadingBlock({ block }: BlockProps<'heading'>) {
  return <h2 className="text-base font-bold text-primary">{block.text}</h2>;
}
