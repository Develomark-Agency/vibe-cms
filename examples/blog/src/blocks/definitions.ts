import { defineBlock } from "@vibe-cms/blocks";
import { image } from "vibe-cms/media";
import v from "vibe-cms/schema";

/*
 * The site's own blocks: what they're called in the editor and which inputs
 * they have. How each renders lives in src/blocks and src/components, so the
 * CMS config (and the Worker and editor that load it) never import site UI.
 */

/** Rendered by an Astro component (src/blocks/Testimonial.astro). */
export const Testimonial = defineBlock({
  type: "testimonial",
  label: "Testimonial",
  icon: "message-square",
  description: "A customer quote with their name and photo",
  fields: {
    quote: v.text({ min: 1, multiline: true, max: 400 }),
    name: v.text({ min: 1, max: 80 }),
    company: v.optional(v.text({ max: 80 })),
    photo: v.optional(image({ alt: "optional", aspectRatio: 1 }))
  }
});

/** Rendered by a React component on the server, with no JavaScript in the browser (src/components/FeatureGrid.tsx). */
export const Features = defineBlock({
  type: "features",
  label: "Feature grid",
  icon: "layers",
  description: "A heading over a grid of short features",
  fields: {
    heading: v.optional(v.text({ max: 120 })),
    items: v.array(
      v.object({ title: v.text({ min: 1, max: 60 }), text: v.text({ multiline: true, max: 240 }) }, { label: "Feature" }),
      { min: 1, max: 9, label: "Features" }
    )
  }
});

/** Rendered by an interactive React island with state (src/blocks/Pricing.astro → src/components/PricingToggle.tsx). */
export const Pricing = defineBlock({
  type: "pricing",
  label: "Pricing",
  icon: "tag",
  description: "Plans with a monthly/yearly switch",
  fields: {
    heading: v.optional(v.text({ max: 120 })),
    plans: v.array(
      v.object({
        name: v.text({ min: 1, max: 40 }),
        monthly: v.number({ min: 0, label: "Monthly price" }),
        yearly: v.number({ min: 0, label: "Yearly price, per month" }),
        features: v.array(v.text({ max: 80 }), { label: "What's included" }),
        highlighted: v.boolean({ label: "Highlight this plan" })
      }, { label: "Plan" }),
      { min: 1, max: 4, label: "Plans" }
    )
  }
});
