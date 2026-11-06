import type { BlockProps } from "vibe-cms/blocks";
import { useState } from "react";
import type { Pricing } from "../blocks/definitions.ts";

/** An interactive React block: state and handlers, hydrated in the browser by src/blocks/Pricing.astro. */
export function PricingToggle({ heading, plans }: BlockProps<typeof Pricing>) {
  const [yearly, setYearly] = useState(false);
  return (
    <section className="pricing">
      {heading && <h2>{heading}</h2>}
      <div className="pricing__switch" role="radiogroup" aria-label="Billing period">
        <button type="button" role="radio" aria-checked={!yearly} onClick={() => setYearly(false)}>Monthly</button>
        <button type="button" role="radio" aria-checked={yearly} onClick={() => setYearly(true)}>Yearly <small>save 20%</small></button>
      </div>
      <div className="pricing__plans">
        {plans.map(plan => (
          <article key={plan.name} className="pricing__plan" data-highlighted={plan.highlighted}>
            <h3>{plan.name}</h3>
            <p className="pricing__price">
              <strong>${yearly ? plan.yearly : plan.monthly}</strong>
              <span>/month{yearly ? ", billed yearly" : ""}</span>
            </p>
            <ul>{plan.features.map(feature => <li key={feature}>{feature}</li>)}</ul>
          </article>
        ))}
      </div>
    </section>
  );
}
