import React from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const base = 'icon-btn';
  const variants: Record<Variant, string> = {
    primary: 'primary',
    secondary: '',
    ghost: '',
    danger: 'danger',
  };
  const sizes: Record<Size, string> = {
    sm: 'sm',
    md: '',
    lg: '',
  };
  return (
    <button className={[base, variants[variant], sizes[size], className].filter(Boolean).join(' ')} {...props}>
      {children}
    </button>
  );
}

export function IconButton({
  children,
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <Button variant={variant} size={size} className={`icon-only ${className}`} {...props}>
      {children}
    </Button>
  );
}

export function Input({
  className = '',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={['search', className].filter(Boolean).join(' ')} {...props} />;
}

export function Textarea({
  className = '',
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={className} {...props} />;
}

export function Select({
  children,
  className = '',
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={['search', className].filter(Boolean).join(' ')} {...props}>{children}</select>;
}

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'err' | 'info' | 'neutral'; className?: string }) {
  const map: Record<string, string> = {
    ok: 'pill ok',
    warn: 'pill warn',
    err: 'pill err',
    info: 'pill info',
    neutral: 'pill neutral',
  };
  return <span className={[map[tone], className].join(' ')}>{children}</span>;
}

export function Card({ children, className = '', title }: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <section className={['card', className].filter(Boolean).join(' ')}>
      {title && <h3>{title}</h3>}
      {children}
    </section>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-label="Loading" role="status">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skel" style={{ width: `${92 - i * 9}%` }} />
      ))}
    </div>
  );
}

export function Empty({ what, hint, action }: { what: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="empty" role="status">
      <b>{what} — no data</b>
      <span>{hint || 'No data available yet.'}</span>
      {action ? <div style={{ marginTop: 8 }}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="err-card">
      <div>{message}</div>
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="empty" role="status">
      <b>{label}…</b>
      <span>Please wait while we load data.</span>
    </div>
  );
}

export function Progress({ value, max = 100, label }: { value: number; max?: number; label?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="budget-wrap" aria-label={label}>
      <div className="budget-bar" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function StatusIndicator({ status }: { status: string }) {
  const s = String(status || '').toLowerCase();
  const cls = /healthy|idle|done|success|completed|warm|live|active|enabled|pass|hit|kept|current/.test(s)
    ? 'healthy'
    : /degraded|running|cooling|warn|planning|stale|reconnecting|compressed|pending|selected/.test(s)
    ? 'degraded'
    : /down|error|failed|cold|disconnected|exceeded|unavailable|miss|removed|rejected/.test(s)
    ? 'down'
    : 'idle';
  return <span className={`status-dot ${cls}`} aria-hidden="true" />;
}

export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="inspector-nav" role="tablist">
      {tabs.map((t) => (
        <a
          key={t.id}
          role="tab"
          aria-selected={active === t.id}
          href="#"
          onClick={(e) => { e.preventDefault(); onChange(t.id); }}
        >
          {t.label}
        </a>
      ))}
    </div>
  );
}

export function Toast({ children, tone = 'primary' }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'err' | 'primary' }) {
  const cls = tone === 'ok' ? 'toast ok' : tone === 'warn' ? 'toast warn' : tone === 'err' ? 'toast err' : 'toast';
  return <div className={cls}>{children}</div>;
}

export function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="model-card">
      <div className="mc-prov">{label}</div>
      <div style={{ fontWeight: 800, fontSize: 18 }}>{value}</div>
      {sub && <div style={{ color: 'var(--muted)', fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  children,
  title,
}: { open: boolean; onClose: () => void; children: React.ReactNode; title?: string }) {
  if (!open) return null;
  return (
    <div className="palette-overlay" role="dialog" aria-modal="true">
      <div className="palette" role="document">
        {title && <h3 style={{ marginTop: 0 }}>{title}</h3>}
        {children}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

export function Drawer({
  open,
  side = 'right',
  onClose,
  children,
}: { open: boolean; side?: 'left' | 'right'; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  const cls = side === 'left' ? 'left open' : 'right open';
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className={cls}>{children}</aside>
    </>
  );
}

export function Tooltip({ children, text }: { children: React.ReactNode; text?: string }) {
  if (!text) return <>{children}</>;
  return (
    <span className="oa-tip" data-tip={text}>
      {children}
    </span>
  );
}

export function Table({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <table className={['table', className].filter(Boolean).join(' ')}>{children}</table>;
}
