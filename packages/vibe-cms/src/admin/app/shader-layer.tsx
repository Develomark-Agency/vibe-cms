import { Aurora, FilmGrain, Satin, Shader } from "shaders/react";
import { materials } from "./texture.tsx";

/** The WebGPU part of `ShaderBackdrop`, split out so its library loads lazily. */
export default function ShaderLayer({ variant, dark, reduced }: { variant: "satin" | "aurora", dark: boolean, reduced: boolean }) {
  const m = dark ? materials.dark : materials.light;
  return (
    <Shader className="absolute inset-0 size-full" disableTelemetry>
      {variant === "satin" ? (
        <Satin
          color={m.satin.color}
          highlightColor={m.satin.highlight}
          // Broad, loose folds lying on a diagonal; no thread texture or long streaks.
          foldCount={3}
          foldWidth={0.34}
          foldDepth={0.3}
          foldDirection={160}
          fiberAngle={160}
          pinning={0}
          anisotropy={0.2}
          weave={0}
          gloss={0.04}
          sheen={0.3}
          bloom={0.2}
          fill={0.2}
          breeze={0.15}
          speed={reduced ? 0 : 0.25}
          lightAngle={reduced ? 215 : { type: "mouse", axis: "x", outputMin: 190, outputMax: 240, smoothing: 0.92 }}
        />
      ) : (
        <Aurora
          colorA={m.aurora.a}
          colorB={m.aurora.b}
          colorC={m.aurora.c}
          intensity={dark ? 55 : 50}
          curtainCount={3}
          rayDensity={8}
          waviness={30}
          speed={reduced ? 0 : 1.2}
          center={reduced ? { x: 0.5, y: 0 } : { type: "mouse-position", y: 0, reach: 0.12, smoothing: 0.94 }}
        />
      )}
      <FilmGrain strength={dark ? 0.1 : 0.08} animated={false} />
    </Shader>
  );
}
