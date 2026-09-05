import React, { useEffect, useState } from 'react';

export function Mark() {
  return (
    <span className="public-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

const LINKS = [
  { href: '#product', label: 'Product' },
  { href: '#how', label: 'How it works' },
  { href: '#models', label: 'Models' },
  { href: '#console', label: 'Console' },
  { href: '#pricing', label: 'Pricing' },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Lock body scroll while the drawer is open so content behind it stays put.
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open ]);
  return (
    <>
      <div className="lp-announce lp-announce-static" role="note">
        <span className="lp-announce-dot" aria-hidden="true" />
        <span>
          <b>Live provider streaming</b> via OpenRouter &amp; Anthropic adapters — BYOK, Demo mode included.
        </span>
        <a href="/auth">Get started →</a>
      </div>
      <header className="lp-navwrap">
        <div className="lp-nav">
          <a href="/" className="public-brand" aria-label="OrchestraAI home">
            <Mark />
            OrchestraAI
          </a>
          <nav aria-label="Primary">
            {LINKS.map((l) => (
              <a key={l.href} href={l.href}>
                {l.label}
              </a>
            ))}
          </nav>
          <div className="lp-nav-actions">
            <a href="/auth" className="lp-link">
              Sign in
            </a>
            <a href="/console" className="lp-btn secondary small">
              Open console
            </a>
            <a href="/auth" className="lp-btn primary small">
              Get started
            </a>
            <button
              className="lp-menu-btn"
              aria-expanded={open}
              aria-controls="lp-mobile-menu"
              aria-label={open ? 'Close menu' : 'Open menu'}
              onClick={() => setOpen((v) => !v)}
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>
          </div>
        </div>
        {open && (
          <nav id="lp-mobile-menu" className="lp-mobile" aria-label="Mobile">
            {LINKS.map((l) => (
              <a key={l.href} href={l.href} onClick={() => setOpen(false)}>
                {l.label}
              </a>
            ))}
            <div className="lp-mobile-cta">
              <a href="/auth" className="lp-btn primary full" onClick={() => setOpen(false)}>
                Get started
              </a>
              <a href="/console" className="lp-btn secondary full" onClick={() => setOpen(false)}>
                Open console
              </a>
              <a href="/auth" className="lp-link" onClick={() => setOpen(false)}>
                Sign in
              </a>
            </div>
          </nav>
        )}
      </header>
    </>
  );
}
