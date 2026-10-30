import type { BlockProps } from "@vibe-cms/blocks";
import type { Features } from "../blocks/definitions.ts";

/** A React block rendered on the server only: no `client:` directive, so it ships no JavaScript. */
export function FeatureGrid({ heading, items }: BlockProps<typeof Features>) {
  return (
    <section style={{ maxWidth: "64rem", margin: "3.5rem auto" }}>
      {heading && <h2 style={{ textAlign: "center", letterSpacing: "-0.02em" }}>{heading}</h2>}
      <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))" }}>
        {items.map(item => (
          <article key={item.title} style={{ padding: "1.25rem", borderRadius: "1rem", boxShadow: "inset 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent)" }}>
            <h3 style={{ margin: "0 0 0.4rem", fontSize: "1.05rem" }}>{item.title}</h3>
            <p style={{ margin: 0, opacity: 0.7 }}>{item.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
