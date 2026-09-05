import React, { useState } from 'react';
import { api } from '../api/client';
import '../styles/public.css';
import { Mark } from './landing/Nav';

export { LandingPage } from './landing/LandingPage';

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>(() => {
    try {
      return new URLSearchParams(window.location.search).get('mode') === 'login' ? 'login' : 'signup';
    } catch { return 'signup'; }
  }); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState(''); const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  let plan: string | null = null;
  try { plan = new URLSearchParams(window.location.search).get('plan'); } catch { plan = null; }
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setError(null); try { if (mode === 'signup') await api.signup(email, password, name); else await api.login(email, password); window.location.assign('/console'); } catch (err) { setError(err instanceof Error ? err.message.replace(/^API \d+ [^:]+:?\s*/, '') : 'Unable to continue'); } finally { setBusy(false); } };
  return <div className="auth-page"><div className="auth-card"><a href="/" className="public-brand"><Mark />OrchestraAI</a><div className="auth-tabs" role="tablist" aria-label="Account"><button role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Create workspace</button><button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button></div><h1>{mode === 'signup' ? 'Start with a clean baseline.' : 'Welcome back.'}</h1><p>{mode === 'signup' ? 'Create your workspace. Connect provider keys after you enter the console.' : 'Continue to your OrchestraAI control center.'}</p>{plan && mode === 'signup' && <p className="auth-plan" role="status">Selected plan: <b>{plan}</b> — plans are usage-based BYOK in beta; no payment is taken today.</p>}<form onSubmit={submit}>{mode === 'signup' && <label>Name<input required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}<label>Work email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label><label>Password<input required type="password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />{mode === 'signup' && <small>Use at least 12 characters.</small>}</label>{error && <div className="auth-error" role="alert">{error}</div>}<button className="public-button full" disabled={busy}>{busy ? 'Working…' : mode === 'signup' ? 'Create workspace →' : 'Sign in →'}</button></form><ul className="auth-notes"><li><b>BYOK:</b> providers bill your account directly — no markup, no card required.</li><li><b>Demo included:</b> explore offline; LIVE needs a verified key in Settings → Providers.</li><li><b>Billing beta:</b> no Stripe subscriptions or auto invoice-matching in V1.</li></ul><p><a className="back-link" href="/pricing">Compare plans</a> · <a className="back-link" href="/">← Back to OrchestraAI</a></p></div></div>;
}
