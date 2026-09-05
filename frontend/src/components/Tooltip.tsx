// Hover-first tooltip: shortcuts are discoverable, not decorative content.
// Shows label + optional shortcut on hover AND keyboard focus. No permanent
// shortcut lists. Accessible via aria-label on the wrapped control.
import React from 'react';

export function Tip({
  label,
  shortcut,
  children,
  side = 'bottom',
}: {
  label: string;
  shortcut?: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <span className={`oa-tip oa-tip-${side}`} data-tip={shortcut ? `${label} · ${shortcut}` : label}>
      {children}
    </span>
  );
}

/** Format a shortcut for the current OS (⌘ on Mac, Ctrl elsewhere). */
export function shortcutLabel(key: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || '');
  if (key === 'mod+k') return mac ? '⌘K' : 'Ctrl+K';
  if (key === 'mod+n') return mac ? '⌘N' : 'Ctrl+N';
  return key;
}
