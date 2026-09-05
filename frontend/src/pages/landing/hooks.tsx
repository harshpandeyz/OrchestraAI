import { useEffect, useRef, useState } from 'react';

/** True when the OS asks for reduced motion. Safe under jsdom/SSR (defaults false). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
    return () => {
      if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return reduced;
}

/**
 * Cycle an integer 0..count-1 on an interval for "alive" product visuals.
 * Pauses when reduced motion is on or the tab is hidden, so animation always
 * communicates state instead of burning cycles.
 */
export function useCycle(count: number, intervalMs: number, disabled = false): number {
  const [i, setI] = useState(0);
  const reduced = useReducedMotion();
  useEffect(() => {
    if (disabled || reduced || count < 2) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (id) return;
      id = setInterval(() => setI((v) => (v + 1) % count), intervalMs);
    };
    const stop = () => {
      if (id) clearInterval(id);
      id = null;
    };
    const onVis = () => {
      if (typeof document !== 'undefined' && document.hidden) stop();
      else start();
    };
    start();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    return () => {
      stop();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    };
  }, [count, intervalMs, disabled, reduced]);
  return i;
}

/** Reveal-on-scroll: adds .in when the host enters the viewport. */
export function Reveal({
  children,
  className = '',
  as: Tag = 'div',
  id,
  labelledBy,
}: {
  children: React.ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
  id?: string;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) {
      el.classList.add('in');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).classList.add('in');
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px -6% 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as never} id={id} aria-labelledby={labelledBy} className={`lp-reveal ${className}`.trim()}>
      {children}
    </Tag>
  );
}
