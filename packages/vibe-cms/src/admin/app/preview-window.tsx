import { animate, motion, useDragControls, useMotionValue, type PanInfo } from "motion/react";
import { CheckIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon, RotateCwIcon, RotateCwSquareIcon, ScalingIcon, SmartphoneIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../components/ui/command.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { Input } from "../components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { cn } from "../lib/utils.ts";
import { DEVICES, matchesDevice, type Device } from "./devices.ts";
import { closePreview, getPreview, popOutPreview, reloadPreview, setPreviewFrame, subscribePreview } from "./preview.ts";

/** The big three newest first, as Playwright lists them; everyone else by name. */
const GROUPS = (["Apple", "Google", "Samsung", "Other"] as const).map(maker => {
  const devices = DEVICES.filter(device => device.maker === maker);
  return { maker, devices: maker === "Other" ? devices.sort((a, b) => a.name.localeCompare(b.name)) : devices };
});

/**
 * A fixed shape for the page's viewport, and the width the page renders at in it (the frame is
 * scaled to the window). Rotating swaps both sides, so a phone's 390 × 845 becomes 845 × 390.
 */
interface Shape {
  w: number,
  h: number,
  width: number,
  /** Picked from the device list: its name and pixel density, shown, not emulated. */
  device?: string,
  density?: number
}

const PRESETS: Array<Shape & { label: string }> = [
  { label: "Desktop", w: 16, h: 9, width: 1280 },
  { label: "Laptop", w: 16, h: 10, width: 1280 },
  { label: "Tablet", w: 4, h: 3, width: 1024 },
  { label: "Classic", w: 3, h: 2, width: 1080 },
  { label: "Square", w: 1, h: 1, width: 800 },
  { label: "Phone", w: 9, h: 19.5, width: 390 }
];

const ZOOMS = [1, 0.75, 0.5];

type Corner = "tl" | "tr" | "bl" | "br";

/** Saved per browser. The window always sits in a corner, so it stays put when the editor resizes. */
interface Layout {
  corner: Corner,
  /** The whole window, title bar included. */
  width: number,
  height: number,
  /** Null is freeform: the page is as wide as the window allows at the zoom. */
  shape: Shape | null,
  /** Page pixels to screen pixels. "fit" (fixed shapes only) scales the page to whatever size the window is. */
  zoom: number | "fit",
  /** Pushed into the bottom-right corner, showing only its top-left, like a macOS Quick Note. */
  tucked?: boolean
}

interface Size {
  width: number,
  height: number
}

const STORAGE_KEY = "vibe-cms:preview-window";
const RECENT_KEY = "vibe-cms:preview-devices";
const MARGIN = 16;
const HEADER = 40;
const MIN_WIDTH = 300;
const MIN_BODY = 160;
/** How much of a tucked window shows, and how much more on hover. */
const PEEK = { width: 168, height: 96 };
const PEEK_HOVER = 32;
/** Released with this much of it past the bottom or right edge, near the bottom-right corner, it tucks away. */
const TUCK_OVERFLOW = 0.25;
/** Pixels per second a settle may inherit from a throw. */
const MAX_VELOCITY = 800;
/** Critically damped: it settles into the corner without bouncing. */
const SETTLE = { type: "spring", stiffness: 520, damping: 46 } as const;

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const EDGES: Array<{ edge: Edge, className: string }> = [
  { edge: "n", className: "inset-x-3 -top-1 h-2 cursor-ns-resize" },
  { edge: "s", className: "inset-x-3 -bottom-1 h-2 cursor-ns-resize" },
  { edge: "w", className: "inset-y-3 -left-1 w-2 cursor-ew-resize" },
  { edge: "e", className: "inset-y-3 -right-1 w-2 cursor-ew-resize" },
  { edge: "nw", className: "-top-1 -left-1 size-4 cursor-nwse-resize" },
  { edge: "se", className: "-right-1 -bottom-1 size-4 cursor-nwse-resize" },
  { edge: "ne", className: "-top-1 -right-1 size-4 cursor-nesw-resize" },
  { edge: "sw", className: "-bottom-1 -left-1 size-4 cursor-nesw-resize" }
];

function loadLayout(): Layout {
  const fallback: Layout = { corner: "br", width: 480, height: 360, shape: null, zoom: 1 };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Layout> | null;
    const layout = { ...fallback, ...saved };
    return { ...layout, zoom: layout.zoom === "fit" || (typeof layout.zoom === "number" && layout.zoom > 0) ? layout.zoom : 1 };
  } catch {
    return fallback;
  }
}

function shapeLabel(shape: Shape): string {
  return shape.device ?? `${shape.w}:${shape.h}`;
}

function percent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/** The room the window has on screen. */
function screenRoom(): Size {
  return { width: innerWidth - 2 * MARGIN, height: innerHeight - 2 * MARGIN };
}

/**
 * A window size that fits within `room` (the screen, by default) and, with a fixed shape, keeps it:
 * too big shrinks both sides.
 */
function fit(size: Size, shape: Shape | null, room: Size = screenRoom()): Size {
  if(!shape) {
    return {
      width: Math.min(Math.max(size.width, MIN_WIDTH), room.width),
      height: Math.min(Math.max(size.height, MIN_BODY + HEADER), room.height)
    };
  }
  const aspect = shape.h / shape.w;
  const width = Math.min(Math.max(size.width, MIN_WIDTH, MIN_BODY / aspect), room.width, (room.height - HEADER) / aspect);
  return { width, height: width * aspect + HEADER };
}

/** The window's size for a layout: a fixed shape at a set zoom sizes the window to the page. */
function layoutSize(layout: Layout): Size {
  const { shape, zoom } = layout;
  if(shape && zoom !== "fit") {
    const width = shape.width * zoom;
    return fit({ width, height: width * shape.h / shape.w + HEADER }, shape);
  }
  return fit(layout, shape);
}

/** Where a window of this size sits in a corner. */
function cornerPosition(corner: Corner, size: Size) {
  return {
    x: corner.endsWith("l") ? MARGIN : innerWidth - size.width - MARGIN,
    y: corner.startsWith("t") ? MARGIN : innerHeight - size.height - MARGIN
  };
}

function capVelocity(v: number): number {
  return Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, v));
}

/** Where a tucked window sits: off the bottom-right, its top-left showing. */
function tuckPosition(hover: boolean) {
  const extra = hover ? PEEK_HOVER : 0;
  return { x: innerWidth - PEEK.width - extra, y: innerHeight - PEEK.height - extra };
}

/** The corner nearest a window's centre. */
function nearestCorner(x: number, y: number, size: Size): Corner {
  const top = y + size.height / 2 < innerHeight / 2;
  const left = x + size.width / 2 < innerWidth / 2;
  return `${top ? "t" : "b"}${left ? "l" : "r"}`;
}

/**
 * The draft preview, floating over the editor. Drag it by its title bar (Motion handles the
 * pointer); it settles into the nearest corner. Resize it from any edge or corner. A fixed shape
 * (a ratio or a real device) keeps the page's viewport that size, scaled to the window.
 */
export function PreviewWindow() {
  const preview = useSyncExternalStore(subscribePreview, getPreview);
  const [layout, setLayout] = useState(loadLayout);
  const [busy, setBusy] = useState<null | "drag" | "resize">(null);
  // During a resize the size lives here, not in `layout`, until the pointer is released.
  const [live, setLive] = useState<Size | null>(null);
  const [slow, setSlow] = useState(false);
  const [body, setBody] = useState<Size>({ width: 0, height: 0 });
  const [, setViewport] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const controls = useDragControls();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [hover, setHover] = useState(false);
  // A press on a tucked window that never became a drag is a click: it comes out.
  const dragged = useRef(false);

  const size = live ?? layoutSize(layout);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {}
  }, [layout]);

  // Re-fit and re-place when the editor's window resizes.
  useEffect(() => {
    function onResize() {
      setViewport(n => n + 1);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // In its corner, unless it's being moved: on opening, after a size change, after the window resizes.
  useLayoutEffect(() => {
    if(!preview.open || busy || x.isAnimating() || y.isAnimating()) return;
    const target = layout.tucked ? tuckPosition(false) : cornerPosition(layout.corner, size);
    x.set(target.x);
    y.set(target.y);
  });

  // A tucked window leans out a little on hover.
  useEffect(() => {
    if(!layout.tucked || busy) return;
    const target = tuckPosition(hover);
    void animate(x, target.x, SETTLE);
    void animate(y, target.y, SETTLE);
  }, [hover]);

  // Opened, pointed at a page or a block: it comes out to be seen.
  const reveals = useRef(preview.reveals);
  useEffect(() => {
    if(reveals.current === preview.reveals) return;
    reveals.current = preview.reveals;
    if(layout.tucked) untuck();
  }, [preview.reveals]);

  useLayoutEffect(() => {
    const element = bodyRef.current;
    if(!element) return;
    const observer = new ResizeObserver(([entry]) => setBody({ width: entry!.contentRect.width, height: entry!.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [preview.open]);

  // A page that never announces itself didn't get the preview script: the cookie was refused, or the site doesn't route through vibe().
  useEffect(() => {
    setSlow(false);
    if(!preview.open || preview.ready) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [preview.open, preview.ready, preview.src]);

  // A release outside the browser can go unreported; the next move with no button held ends the drag.
  useEffect(() => {
    if(busy !== "drag") return;
    function onMove(event: PointerEvent) {
      if(event.buttons === 0) controls.stop();
    }
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [busy]);

  if(!preview.open || !preview.src) return null;

  // A fixed shape renders the page at its own width, scaled to the window; freeform at the zoom, as wide as the window allows.
  const { shape } = layout;
  const scale = shape ? (body.width ? body.width / shape.width : 1) : layout.zoom === "fit" ? 1 : layout.zoom;
  const page = shape ? { width: shape.width, height: Math.round(shape.width * shape.h / shape.w) } : { width: Math.round(body.width / scale), height: Math.round(body.height / scale) };

  /** Eases into a corner, carrying some of the throw's velocity: capped, so a hard flick can't sail past it. */
  function settle(corner: Corner, next: Size, velocity = { x: 0, y: 0 }) {
    const target = cornerPosition(corner, next);
    void animate(x, target.x, { ...SETTLE, velocity: capVelocity(velocity.x) });
    void animate(y, target.y, { ...SETTLE, velocity: capVelocity(velocity.y) });
  }

  function onDragEnd(_: unknown, info: PanInfo) {
    // Where a flick was heading decides the corner, and whether it tucks away.
    const px = x.get() + info.velocity.x * 0.2;
    const py = y.get() + info.velocity.y * 0.2;
    const corner = nearestCorner(px, py, size);
    const overflow = Math.max((px + size.width - innerWidth) / size.width, (py + size.height - innerHeight) / size.height);
    setBusy(null);
    setHover(false);
    if(corner === "br" && overflow > TUCK_OVERFLOW) {
      // No carried velocity: it's already heading off-screen, and must stop with its corner showing.
      const target = tuckPosition(false);
      void animate(x, target.x, SETTLE);
      void animate(y, target.y, SETTLE);
      setLayout(current => ({ ...current, corner, tucked: true }));
      return;
    }
    settle(corner, size, info.velocity);
    setLayout(current => ({ ...current, corner, tucked: false }));
  }

  function untuck() {
    setHover(false);
    settle(layout.corner, size);
    setLayout(current => ({ ...current, tucked: false }));
  }

  /** Resizes from an edge or corner; the opposite side stays put. With a fixed shape, the axis dragged further leads. */
  function resize(event: ReactPointerEvent<HTMLDivElement>, edge: Edge) {
    if(event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const start = { px: event.clientX, py: event.clientY, x: x.get(), y: y.get(), ...size };
    const west = edge.includes("w");
    const north = edge.includes("n");
    const horizontal = west || edge.includes("e");
    const vertical = north || edge.includes("s");
    // Up to the screen's edge on the sides that move.
    const room = {
      width: west ? start.x + start.width - MARGIN : horizontal ? innerWidth - MARGIN - start.x : innerWidth - 2 * MARGIN,
      height: north ? start.y + start.height - MARGIN : vertical ? innerHeight - MARGIN - start.y : innerHeight - 2 * MARGIN
    };
    let latest: Size = { width: start.width, height: start.height };
    setBusy("resize");

    function onMove(move: PointerEvent) {
      if(move.buttons === 0) return onUp();
      const dx = horizontal ? (move.clientX - start.px) * (west ? -1 : 1) : 0;
      const dy = vertical ? (move.clientY - start.py) * (north ? -1 : 1) : 0;
      let width = start.width + dx;
      if(shape && (!horizontal || (vertical && Math.abs(dy) > Math.abs(dx)))) {
        width = (start.height + dy - HEADER) * shape.w / shape.h;
      }
      latest = fit({ width, height: start.height + dy }, shape, room);
      x.set(west ? start.x + start.width - latest.width : start.x);
      y.set(north ? start.y + start.height - latest.height : start.y);
      setLive(latest);
    }
    function onUp() {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.removeEventListener("lostpointercapture", onUp);
      const corner = nearestCorner(x.get(), y.get(), latest);
      settle(corner, latest);
      setLive(null);
      setBusy(null);
      // Resizing a fixed shape picks its zoom; freeform keeps its zoom and gains page width.
      setLayout(current => ({ ...current, ...latest, corner, zoom: current.shape ? "fit" : current.zoom }));
    }
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    handle.addEventListener("lostpointercapture", onUp);
  }

  /** Switches shape. Into freeform, the page keeps its current zoom; into a fixed shape, about the same page area. */
  function setShape(next: Shape | null) {
    setLayout(current => {
      if(!next) return { ...current, ...size, shape: null, zoom: scale };
      const area = size.width * (size.height - HEADER);
      const width = Math.sqrt(area * next.w / next.h);
      return { ...current, shape: next, zoom: "fit", ...fit({ width, height: width * next.h / next.w + HEADER }, next) };
    });
  }

  function rotate() {
    if(!shape) return;
    setLayout(current => {
      const rotated = { ...shape, w: shape.h, h: shape.w, width: Math.round(shape.width * shape.h / shape.w) };
      if(current.zoom !== "fit") return { ...current, shape: rotated };
      const width = Math.sqrt(size.width * (size.height - HEADER) * rotated.w / rotated.h);
      return { ...current, shape: rotated, ...fit({ width, height: width * rotated.h / rotated.w + HEADER }, rotated) };
    });
  }

  function setZoom(zoom: number | "fit") {
    setLayout(current => (zoom === "fit" ? { ...current, zoom, ...size } : { ...current, zoom }));
  }

  // A set zoom the screen can't fit shows what it really is.
  const zoomLabel = percent(scale);

  return (
    <motion.div
      role="dialog"
      aria-label="Draft preview"
      drag
      dragListener={false}
      dragControls={controls}
      dragMomentum={false}
      dragElastic={0.05}
      // Free to go past the bottom and right edges, into the corner to tuck away; never so far that it can't be grabbed.
      dragConstraints={{ left: MARGIN, top: MARGIN, right: innerWidth - PEEK.width, bottom: innerHeight - PEEK.height }}
      onDragStart={() => {
        dragged.current = true;
        setBusy("drag");
      }}
      onDragEnd={onDragEnd}
      className="fixed top-0 left-0 z-40 flex flex-col rounded-[14px] bg-background shadow-[0_0_0_1px_var(--border),0_12px_40px_-8px_rgb(0_0_0/0.3)]"
      style={{ x, y, width: size.width, height: size.height }}
    >
      <div
        className={cn("flex shrink-0 cursor-grab touch-none items-center gap-1 border-b pr-1.5 pl-3 select-none", busy === "drag" && "cursor-grabbing")}
        style={{ height: HEADER }}
        onPointerDown={event => {
          // Menus are portalled elsewhere but their events still bubble here through React; only presses on the bar itself drag.
          const target = event.target as HTMLElement;
          if(event.button !== 0 || !event.currentTarget.contains(target) || target.closest("button, input")) return;
          // Otherwise the drag also selects the editor's text.
          event.preventDefault();
          controls.start(event);
        }}
      >
        {/* Narrow windows (a phone) keep the title bar for the controls. */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {size.width >= 440 && (
            <>
              <span className="shrink-0 text-xs font-medium">Preview</span>
              <span className="truncate font-mono text-[11px] text-muted-foreground">{preview.path ?? ""}</span>
            </>
          )}
        </div>
        <ShapePicker shape={shape} onChange={setShape} pageWidth={page.width} compact={size.width < 400} />
        {shape && (
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Rotate" onClick={rotate}><RotateCwSquareIcon /></Button>} />
            <TooltipContent>Rotate</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger render={
              <DropdownMenuTrigger render={
                <Button variant="ghost" size="xs" className="px-1.5 font-mono text-[11px] tabular-nums text-muted-foreground" aria-label={`Zoom: ${zoomLabel}`}>{zoomLabel}</Button>
              } />
            } />
            <TooltipContent>{page.width} × {page.height} at {zoomLabel}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-40">
            <p className="px-2 py-1.5 font-mono text-xs text-muted-foreground">{page.width} × {page.height}</p>
            <DropdownMenuRadioGroup value={String(layout.zoom)} onValueChange={value => setZoom(value === "fit" ? "fit" : Number(value))}>
              {shape && <DropdownMenuRadioItem value="fit">Fit to window</DropdownMenuRadioItem>}
              {ZOOMS.map(zoom => <DropdownMenuRadioItem key={zoom} value={String(zoom)}>{percent(zoom)}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Reload" onClick={reloadPreview}><RotateCwIcon /></Button>} />
          <TooltipContent>Reload</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Open in a new window" onClick={() => void popOutPreview()}><ExternalLinkIcon /></Button>} />
          <TooltipContent>Open in a new window</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon-xs" aria-label="Close preview" onClick={closePreview}><XIcon /></Button>
      </div>
      <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-hidden rounded-b-[14px] bg-muted/40">
        {body.width > 0 && (
          <iframe
            // Known before the page loads, so its first message is recognised as the frame's.
            ref={element => setPreviewFrame(element?.contentWindow ?? null)}
            src={preview.src}
            title="Draft preview"
            className={cn("absolute top-0 left-0 border-0 bg-white", busy && "pointer-events-none")}
            style={{ width: body.width / scale, height: body.height / scale, transform: `scale(${scale})`, transformOrigin: "0 0" }}
          />
        )}
        {!preview.ready && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 p-6 text-center text-sm text-muted-foreground">
            {slow ? (
              <>
                <p>The preview didn't connect. Your browser may block its cookie inside this frame.</p>
                <Button variant="outline" size="sm" onClick={() => void popOutPreview()}><ExternalLinkIcon /> Open in a new window</Button>
              </>
            ) : <Spinner />}
          </div>
        )}
      </div>
      {layout.tucked ? (
        // Tucked, the whole visible corner is a handle: hover leans it out, a click brings it back, a drag pulls it out.
        <div
          role="button"
          tabIndex={0}
          aria-label="Show preview"
          className="absolute inset-0 z-20 cursor-pointer touch-none rounded-[14px]"
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          onPointerDown={event => {
            if(event.button !== 0) return;
            event.preventDefault();
            dragged.current = false;
            controls.start(event);
          }}
          onClick={() => {
            if(!dragged.current) untuck();
          }}
          onKeyDown={event => {
            if(event.key === "Enter" || event.key === " ") untuck();
          }}
        />
      ) : EDGES.map(({ edge, className }) => (
        <div key={edge} aria-hidden className={cn("absolute z-10 touch-none", className)} onPointerDown={event => resize(event, edge)} />
      ))}
    </motion.div>
  );
}

function loadRecent(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((name): name is string => DEVICES.some(d => d.name === name)) : [];
  } catch {
    return [];
  }
}

function deviceShape(device: Device): Shape {
  return { w: device.width, h: device.height, width: device.width, device: device.name, density: device.scale };
}

/** Freeform, or fixed: a ratio preset, a device, or a ratio of your own. */
function ShapePicker({ shape, onChange, pageWidth, compact }: { shape: Shape | null, onChange(shape: Shape | null): void, pageWidth: number, compact: boolean }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"shapes" | "devices">("shapes");
  const [custom, setCustom] = useState({ w: "", h: "" });
  const [recent, setRecent] = useState(loadRecent);
  const [search, setSearch] = useState("");
  const w = Number(custom.w);
  const h = Number(custom.h);
  const valid = w > 0 && h > 0 && w / h <= 10 && h / w <= 10;

  function pick(next: Shape) {
    onChange(next);
    setOpen(false);
    if(next.device) {
      const names = [next.device, ...recent.filter(name => name !== next.device)].slice(0, 4);
      setRecent(names);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(names));
      } catch {}
    }
  }

  /** A rotated shape is still the shape it came from. */
  function isCurrent(candidate: Shape) {
    if(!shape) return false;
    if(candidate.device || shape.device) return candidate.device === shape.device;
    return (candidate.w === shape.w && candidate.h === shape.h) || (candidate.w === shape.h && candidate.h === shape.w);
  }

  const segment = "flex h-6 items-center gap-1 rounded-[7px] px-2 text-xs text-muted-foreground transition-colors hover:text-foreground";
  const row = "flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-sm hover:bg-foreground/[0.05]";
  const recentDevices = recent.map(name => DEVICES.find(d => d.name === name)!);
  return (
    <div className="flex min-w-0 items-center rounded-[9px] well p-0.5">
      {/* Narrow, Freeform is an icon, leaving room for a device's name. */}
      <button type="button" aria-pressed={!shape} aria-label="Freeform" title={compact ? "Freeform" : undefined} onClick={() => onChange(null)} className={cn(segment, compact && "px-1.5", !shape && "raised text-foreground")}>
        {compact ? <ScalingIcon className="size-3.5" /> : "Freeform"}
      </button>
      <Popover open={open} onOpenChange={next => {
        setOpen(next);
        if(next) {
          setView(shape?.device ? "devices" : "shapes");
          setSearch("");
        }
      }}>
        <PopoverTrigger render={
          <button type="button" aria-pressed={Boolean(shape)} className={cn(segment, "min-w-0", shape && "raised text-foreground")}>
            <span className="max-w-28 truncate">{shape ? shapeLabel(shape) : "Fixed"}</span> <ChevronDownIcon className="size-3 shrink-0" />
          </button>
        } />
        <PopoverContent align="end" className="w-72 gap-0.5 p-1.5">
          {view === "shapes" ? (
            <>
              {PRESETS.map(preset => (
                <button key={preset.label} type="button" onClick={() => pick(preset)} className={row}>
                  <span className="flex w-5 justify-center text-muted-foreground">
                    <span
                      className="rounded-[2px] border-[1.5px] border-current"
                      style={preset.w >= preset.h ? { width: 16, height: 16 * preset.h / preset.w } : { width: 16 * preset.w / preset.h, height: 16 }}
                    />
                  </span>
                  <span className="flex-1">{preset.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">{preset.w}:{preset.h}</span>
                  {isCurrent(preset) ? <CheckIcon className="size-3.5" /> : <span className="size-3.5" />}
                </button>
              ))}
              <button type="button" onClick={() => setView("devices")} className={cn(row, "mt-1 border-t pt-1")}>
                <span className="flex w-5 justify-center text-muted-foreground"><SmartphoneIcon className="size-4" /></span>
                <span className="flex-1">Devices</span>
                {shape?.device && <span className="max-w-24 truncate text-xs text-muted-foreground">{shape.device}</span>}
                <ChevronRightIcon className="size-3.5 text-muted-foreground" />
              </button>
              <form
                className="mt-1 flex items-center gap-1.5 border-t px-1 pt-2"
                onSubmit={event => {
                  event.preventDefault();
                  // A ratio of your own renders at the page's current width.
                  if(valid) pick({ w, h, width: Math.max(320, pageWidth) });
                }}
              >
                <Input aria-label="Ratio width" inputMode="decimal" placeholder="W" value={custom.w} onChange={e => setCustom(c => ({ ...c, w: e.target.value }))} className="h-7 w-12 px-2 text-center text-xs" />
                <span className="text-xs text-muted-foreground">:</span>
                <Input aria-label="Ratio height" inputMode="decimal" placeholder="H" value={custom.h} onChange={e => setCustom(c => ({ ...c, h: e.target.value }))} className="h-7 w-12 px-2 text-center text-xs" />
                <Button type="submit" variant="outline" size="xs" className="ml-auto" disabled={!valid}>Use</Button>
              </form>
            </>
          ) : (
            // Our own matching (`matchesDevice`), not cmdk's fuzzy filter, which finds "pixel" in "iPhone X Apple".
            <Command className="bg-transparent p-0" shouldFilter={false}>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon-xs" aria-label="Back to shapes" onClick={() => setView("shapes")}><ChevronLeftIcon /></Button>
                <span className="text-xs font-medium">Devices</span>
              </div>
              <CommandInput placeholder="Search devices…" autoFocus value={search} onValueChange={setSearch} />
              <CommandList className="max-h-72">
                <CommandEmpty>No devices found.</CommandEmpty>
                {!search && recentDevices.length > 0 && (
                  <CommandGroup heading="Recent">
                    {recentDevices.map(device => <DeviceItem key={`recent-${device.name}`} device={device} value={`recent ${device.name}`} checked={shape?.device === device.name} onPick={pick} />)}
                  </CommandGroup>
                )}
                {GROUPS.map(({ maker, devices }) => {
                  const shown = devices.filter(device => matchesDevice(device, search));
                  return shown.length > 0 && (
                    <CommandGroup key={maker} heading={maker}>
                      {shown.map(device => (
                        <DeviceItem key={device.name} device={device} value={device.name} checked={shape?.device === device.name} onPick={pick} />
                      ))}
                    </CommandGroup>
                  );
                })}
              </CommandList>
            </Command>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function DeviceItem({ device, value, checked, onPick }: { device: Device, value: string, checked: boolean, onPick(shape: Shape): void }) {
  return (
    <CommandItem value={value} keywords={[device.maker]} data-checked={checked} onSelect={() => onPick(deviceShape(device))}>
      {/* The name gets the whole row; the specs sit under it. */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{device.name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">{device.width} × {device.height} · @{device.scale}x</span>
      </span>
    </CommandItem>
  );
}
