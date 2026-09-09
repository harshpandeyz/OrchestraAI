import React from 'react';
import { Analytics } from './Analytics';
import { FinalCTA, Footer } from './Closing';
import { Execution, Reliability } from './Execution';
import { Hero } from './Hero';
import { Nav } from './Nav';
import { Routing } from './Routing';
import { StrategyDemo } from './StrategyDemo';
import { ConsoleShowcase, Pricing, Security } from './Showcase';
import { CapabilityStrip, Why } from './Why';

/**
 * Landing composition. Narrative order:
 * nav → hero (decision engine alive) → lifecycle strip → why stories →
 * routing graph + decision panel → analytics → execution → reliability →
 * console → security → pricing → final CTA → footer.
 */
export function LandingPage() {
  return (
    <div className="marketing lp">
      <Nav />
      <main>
        <Hero />
        <CapabilityStrip />
        <Why />
        <Routing />
        <StrategyDemo />
        <Analytics />
        <Execution />
        <Reliability />
        <ConsoleShowcase />
        <Security />
        <Pricing />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}
