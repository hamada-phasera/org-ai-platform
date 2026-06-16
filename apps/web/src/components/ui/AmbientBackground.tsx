/**
 * AmbientBackground — clean, theme-aware backdrop.
 * Flat canvas + one very subtle accent glow + faint grid. No rainbow/glass.
 */
export function AmbientBackground() {
  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden pointer-events-none bg-canvas">
      {/* subtle accent glow, top-right */}
      <div
        className="absolute -top-40 -right-32 h-[520px] w-[520px] rounded-full blur-3xl opacity-[0.06]"
        style={{ background: 'radial-gradient(circle, var(--accent) 0%, transparent 70%)' }}
      />
      {/* faint grid */}
      <div
        className="absolute inset-0 opacity-[0.5] dark:opacity-[0.35]"
        style={{
          backgroundImage:
            'linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, #000 30%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 60% at 50% 0%, #000 30%, transparent 75%)',
        }}
      />
    </div>
  );
}
