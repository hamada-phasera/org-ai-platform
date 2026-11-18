import { Button } from '../../ui';
import { useSubmit } from '../useSubmit';
import type { BlockProps } from './types';

/** 横並び（スマホは縦積み・全幅）。入力は無い。confirm があれば確認してから送る */
export function ButtonsBlock({ block, index }: BlockProps<'buttons'>) {
  const submit = useSubmit();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2 max-lg:flex-col">
        {block.items.map((item, i) => (
          <Button
            key={i}
            type="button"
            variant={item.style === 'primary' ? 'primary' : 'secondary'}
            className="max-lg:w-full"
            disabled={submit.busy}
            onClick={() => submit.trigger({ actionId: item.action, input: {}, origin: { blockIndex: index, itemIndex: i } })}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {submit.feedback}
      {submit.dialog}
    </div>
  );
}
