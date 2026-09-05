# Agent 5 — Frontend / Product handoff

## Changed files (all inside frontend/**)
- `frontend/src/App.tsx` — added public `/pricing` route (`PricingPage`); `/` and `/auth` unchanged.
- `frontend/src/pages/landing/Showcase.tsx` — `Pricing` section is now 4 honest tiers (Trial / Pro / Team / Enterprise-contact) with feature boundaries, beta/manual-billing note, CTAs to `/auth?plan=*`, link to `/pricing`. Kept H2 "Bring your keys. Pay providers directly." and `#pricing` anchor (landing tests depend on both).
- `frontend/src/pages/pricing.tsx` (new) — standalone pricing page: same 4 tiers + FAQ (no markup, modeled≠invoice, no Stripe in V1, demo vs live).
- `frontend/src/pages/public.tsx` — `AuthPage`: `?plan=` chip, `?mode=login`, tablist roles, BYOK / Demo-included / billing-beta notes, link to `/pricing`.
- `frontend/src/components/Onboarding.tsx` — 3 steps → 5 steps: Workspace ready → Connect provider → Verify & pick mode (demo-vs-live explainer) → First run → Understand savings. No auto-approve; keys write-only via existing `connectProvider`.
- `frontend/src/components/economics.tsx` (new) — `EconomicsLegend` + `CostBasisBadge`. Labels only; zero price/fee/savings math in frontend.
- `frontend/src/components/product-states.tsx` (new) — `PageError`, `DemoModeNote`, `NoProviderNote`, `DegradedNote`, `ReconciliationNote`. Unknown stays unknown; no fake zeroes.
- `frontend/src/pages/account.tsx` — `BillingPage` full UX: plan (beta/manual), period, modeled baseline, actual provider spend, platform fee (+pct), final cost, net savings, data-quality line, `EconomicsLegend`, reconciliation honesty, loading/error-retry/empty states. `OperationsPage` now surfaces load errors with retry instead of silent empty.
- `frontend/src/pages/command-center.tsx` — Overview/Savings: `CostBasisBadge` (Actual/Modeled/Verified/Insufficient/Incomplete) on hero metrics + `EconomicsLegend`; errors via `PageError` with no invented zeroes.
- `frontend/src/pages/landing/Closing.tsx` — footer Pricing link now points to `/pricing` (real page) instead of `#pricing`.
- `frontend/src/styles/public.css` — tier grid, pricing page, FAQ, legend/state styles, mobile breakpoints, focus-visible.
- `frontend/src/styles/account.css` — ≤480px econ-grid collapse, focus-visible, touch targets.
- `frontend/src/test/product.test.tsx` (new) — 17 tests (see below).

Console architecture (`console/`, `Center`, `LiveIntelligence`, store, SSE) preserved untouched.

## API endpoints consumed (all via `frontend/src/api/client.ts`, no ad-hoc fetch)
`getBilling`, `getOverview`, `getSavings`, `getProviders`, `connectProvider`, `signup`, `login`. No new endpoints; no backend changes made or needed.

## Pricing / product decisions
- 4 tiers map to `?plan=trial|pro|team|enterprise`; Enterprise CTA goes to `/auth?plan=enterprise` labeled "manual onboarding in beta" — no fake sales email, no Stripe claims anywhere.
- Billing copy everywhere: "beta/manual reconciliation", "modeled, not invoice-reconciled", "no self-serve subscriptions or auto invoice-matching in V1".
- Landing keeps all "illustrative demo data" labels; no logos/numbers/testimonials added.

## Tests
- New `frontend/src/test/product.test.tsx`: 17 tests covering landing tiers + CTAs, pricing page FAQ, mobile menu, auth BYOK/demo/beta notes + login error, economics legend/badges, overview error (no fake $0.000), savings loading, billing full/empty/error states, onboarding 5-step + demo dismiss, routing-explanation factors, button labeling.
- Full suite: **11 files, 128 tests, all pass**. `tsc --noEmit` clean.
- Note: jsdom here runs without a localStorage file, so `Onboarding` (private-mode-silent when storage throws) is tested with a memory-storage stub inside the test file only.

## Remaining backend contract assumptions
- `GET /api/billing` returns `{ billing: { period?, currency?, runCount, baselineCost, optimizedProviderCost, platformFee, platformFeePct?, customerFinalCost, customerNetSavings, savingsRate?, invoiceStatus, source?, dataQuality? }, lineItems[], note }` — extra fields are optional-chained; missing values render "—".
- Plan is NOT returned by the backend, so Billing shows "Beta/manual — no subscription in V1" rather than inventing a plan name. If backend later returns `billing.plan`, wire it in `BillingPage` (one-line change).
- Reconciliation is trusted only when `invoiceStatus`/`reconciliation === 'reconciled' | 'invoice_reconciled'`; everything else renders "Not invoice-reconciled".

## Exact areas Agent 7 should verify
1. `/pricing` public route renders standalone page; `#pricing` anchor still on landing; footer links correct.
2. Billing page with real backend: period/currency/fee-pct/quality lines populate; empty workspace shows honest empty (no zeroes); kill backend → error + retry, nothing assumed.
3. Signup with `?plan=enterprise` shows plan chip; signup → `/console` flow intact.
4. Onboarding appears once for fresh workspaces (clears via `orchestra-onboarded-v1`), all 5 steps keyboard-navigable, Esc/demo-dismiss works.
5. Overview/Savings badges match backend `calculationStatus` (`verified_modeled` → VERIFIED, else INSUFFICIENT/INCOMPLETE) — never show savings as billed.
6. Mobile ≤768px: tier grid stacks, econ-grid collapses ≤480px, console drawers/scrim unchanged; focus-visible outlines on new buttons.
7. No `fetch()` outside `api/client.ts`; no frontend price math (only `usd` display formatting of backend numbers).
