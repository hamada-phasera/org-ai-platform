import { Monitor } from 'lucide-react';

interface DesktopOnlyProps {
  /** 何を開こうとしたのか。「この機能は」より具体的に書く。 */
  what?: string;
}

/**
 * スマホでは開かない画面に出す誘導。
 *
 * 「非対応」を黙って隠すのではなく、分担として見せる。
 * エージェントの手順編集や AI ログの監査は表が横に長く、
 * スマホに載せても正確に扱えないため。
 */
export function DesktopOnly({ what = 'この画面' }: DesktopOnlyProps) {
  return (
    <div className="flex h-full items-center justify-center px-5 py-10">
      <div className="w-full max-w-sm rounded-xl border border-border bg-elevated p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-sunken">
            <Monitor size={16} strokeWidth={2} className="text-secondary" aria-hidden="true" />
          </span>
          <h2 className="text-sm font-extrabold">{what}はパソコンでご利用ください</h2>
        </div>
        <p className="mt-2.5 text-sm leading-relaxed text-secondary">
          表が横に長く、スマホでは正確に扱えません。
          <b className="text-primary">閲覧・承認・チャットはスマホ</b>、
          <b className="text-primary">設定と監査はパソコン</b>という分担にしています。
        </p>
      </div>
    </div>
  );
}

export default DesktopOnly;
