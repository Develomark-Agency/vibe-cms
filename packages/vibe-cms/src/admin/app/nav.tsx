import { AppWindowIcon, ChevronDownIcon, HomeIcon, MenuIcon, SearchIcon, Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Kbd } from "../components/ui/kbd.tsx";
import { NavigationMenu, NavigationMenuContent, NavigationMenuItem, NavigationMenuLink, NavigationMenuList, NavigationMenuTrigger } from "../components/ui/navigation-menu.tsx";
import { cn } from "../lib/utils.ts";
import { useAdmin, collectionSettings } from "./context.tsx";
import { useTypeStats } from "./pages.tsx";
import { Link, useLocation } from "./router.tsx";

export interface NavItem {
  key: string,
  to: string,
  label: string,
  icon: ReactNode,
  /** A content type: its document count is shown beside it. */
  type?: string
}

export interface NavGroup {
  key: string,
  label: string,
  items: NavItem[]
}

interface Section { label?: string, items: NavItem[] }

/** Past this many entries a menu gets a filter field. */
const LARGE = 8;
/** Items stack down a column to this many before another column starts, up to three. */
const ROWS = 6;
const COLUMN = 250;

function useViewportWidth() {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    function onResize() {
      setWidth(window.innerWidth);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

function pathOf(to: string) {
  return to.split("?")[0]!;
}

/** The text under an item's name, from the type's stats. */
function useItemNotes(items: NavItem[], enabled: boolean) {
  const { config, session } = useAdmin();
  const types = Object.keys(config.schemas).filter(t => session.permissions.types[t]?.read);
  const stats = useTypeStats(types, enabled);
  return (item: NavItem): string | undefined => {
    if(!item.type) return undefined;
    const entry = stats.data?.find(s => s.type === item.type);
    if(!entry) return undefined;
    if(collectionSettings(config, item.type).singleton) return entry.total ? "Set" : "Not set";
    return `${entry.total} ${entry.total === 1 ? "entry" : "entries"}`;
  };
}

/**
 * The editor's navigation: a bar above the page. Search, the dashboard and the preview are always there, then one tab per
 * group of content types; a tab opens a menu of its items, so any number of items and groups fits. Groups that don't
 * fit the bar move into "More". On a phone the whole bar is one Menu button.
 */
export function MegaNav({ groups, isActive, onSearch, previewOpen, onPreview, trash, account }: {
  groups: NavGroup[],
  isActive(to: string): boolean,
  onSearch(): void,
  previewOpen: boolean,
  onPreview(): void,
  trash: { to: string } | null,
  account: ReactNode
}) {
  const { path } = useLocation();
  const [open, setOpen] = useState<string | null>(null);
  // A menu opened by hovering doesn't take the keyboard; one opened by a press or a key is ready to be typed into.
  const byHover = useRef(false);
  const [mobile, setMobile] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const all = useMemo(() => groups.flatMap(g => g.items), [groups]);
  const viewport = useViewportWidth();
  // Each menu is as wide as its items need: they stack down a column first, then across.
  function layout(entry: { sections: Section[] }) {
    const count = entry.sections.reduce((n, section) => n + section.items.length, 0);
    const room = Math.max(1, Math.floor((viewport - 24 - 20) / COLUMN));
    const columns = Math.min(3, Math.max(1, Math.ceil(count / ROWS)), room);
    return { columns, width: Math.min(columns * COLUMN + 20, viewport - 24) };
  }
  const note = useItemNotes(all, open !== null || mobile);

  useEffect(() => {
    setOpen(null);
    setMobile(false);
  }, [path]);
  // The phone's sheet closes on Escape or a press outside; the desktop menus do that themselves.
  useEffect(() => {
    if(!mobile) return;
    function onPointer(event: PointerEvent) {
      if(!rootRef.current?.contains(event.target as Node)) setMobile(false);
    }
    function onKey(event: globalThis.KeyboardEvent) {
      if(event.key === "Escape") setMobile(false);
    }
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [mobile]);

  // Which group tabs fit the bar; the rest go under "More".
  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(groups.length);
  const labels = groups.map(g => g.label).join("\n");
  useLayoutEffect(() => {
    const row = rowRef.current;
    const measure = measureRef.current;
    if(!row || !measure) return;
    function compute() {
      const widths = [...measure!.children].map(child => (child as HTMLElement).offsetWidth + 2);
      const room = row!.clientWidth;
      if(widths.reduce((a, b) => a + b, 0) <= room) return setFit(widths.length);
      let used = 92;
      let count = 0;
      for(const width of widths) {
        if(used + width > room) break;
        used += width;
        count++;
      }
      setFit(count);
    }
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(row);
    return () => observer.disconnect();
  }, [labels]);

  const shown = groups.slice(0, fit);
  const overflow = groups.slice(fit);
  const tabs: Array<{ key: string, title: string, sections: Section[], large: boolean }> = shown.map(group => ({
    key: group.key, title: group.label, sections: [{ items: group.items }], large: group.items.length > LARGE
  }));
  if(overflow.length) tabs.push({ key: "more", title: "More", sections: overflow.map(g => ({ label: g.label, items: g.items })), large: overflow.reduce((n, g) => n + g.items.length, 0) > LARGE });
  function groupActive(sections: Section[]) {
    return sections.some(section => section.items.some(item => isActive(pathOf(item.to))));
  }

  // Placed here rather than by collision detection, which would lag a width that is still animating: the menu's left edge
  // is where its tab is, pulled back just far enough for the width it is growing to.
  const triggers = useRef<Record<string, HTMLElement | null>>({});
  const lastOffset = useRef(0);
  const current = tabs.find(entry => entry.key === open);
  const anchor = current && triggers.current[current.key];
  if(current && anchor) {
    const left = anchor.getBoundingClientRect().left;
    lastOffset.current = Math.max(12 - left, Math.min(0, viewport - 12 - (left + layout(current).width)));
  }

  const tab = "relative flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[background-color,box-shadow,color,scale] duration-150 ease-out outline-none hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]";
  const tabOn = "raised text-foreground";
  // An open tab is the dark one, over whatever its active state paints.
  const tabOpen = "data-popup-open:bg-foreground data-popup-open:bg-none data-popup-open:text-background data-popup-open:shadow-none data-popup-open:hover:bg-foreground data-popup-open:hover:text-background";

  const currentLabel = all.find(item => isActive(pathOf(item.to)))?.label ?? (path === "/" ? "Dashboard" : trash && isActive(trash.to) ? "Trash" : "");

  return (
    <div
      ref={rootRef}
      className="relative z-20"
      onClick={event => {
        // Following a link closes the menu even when it points at the page already open. (Events from the portaled popup still bubble here.)
        const target = event.target as HTMLElement;
        if(target.closest("[data-menu] a")) setMobile(false);
        if(target.closest("[data-slot=navigation-menu-popup] a")) setOpen(null);
      }}
    >
      {/* Phone: one button. */}
      <div className="flex h-14 items-center gap-2 px-3 md:hidden">
        <button
          type="button"
          aria-expanded={mobile}
          onClick={() => setMobile(value => !value)}
          className={cn("flex h-10 items-center gap-2 rounded-[12px] px-3.5 text-sm font-medium transition-[background-color,scale] duration-150 active:scale-[0.98]", mobile ? "bg-foreground text-background" : "raised")}
        >
          {mobile ? <XIcon className="size-4" /> : <MenuIcon className="size-4" />} Menu
        </button>
        <span className="min-w-0 flex-1 truncate px-1 text-sm text-muted-foreground">{currentLabel}</span>
        <button type="button" onClick={onSearch} aria-label="Search" className="flex size-10 items-center justify-center rounded-[12px] well text-muted-foreground"><SearchIcon className="size-4" /></button>
      </div>

      {/* Wider than a phone: the bar. */}
      <div className="hidden h-14 items-center gap-1 px-3 md:flex">
        <button
          type="button"
          onClick={onSearch}
          aria-label="Search"
          className="mr-1 flex h-9 w-9 shrink-0 items-center gap-2 rounded-[10px] well text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:w-44 lg:pr-1.5 lg:pl-2.5"
        >
          <SearchIcon className="mx-auto size-4 shrink-0 lg:mx-0" />
          <span className="hidden flex-1 text-left lg:inline">Search…</span>
          <Kbd className="hidden h-6 rounded-[4px] px-1.5 lg:inline-flex">⌘J</Kbd>
        </button>
        <Link to="/" className={cn(tab, isActive("/") && tabOn)} aria-label="Dashboard"><HomeIcon className={cn("size-4", isActive("/") && "text-brand")} /><span className="hidden lg:inline">Dashboard</span></Link>
        <button type="button" onClick={onPreview} aria-pressed={previewOpen} aria-label="Preview" className={cn(tab, previewOpen && tabOn)}>
          <AppWindowIcon className={cn("size-4", previewOpen && "text-brand")} /><span className="hidden lg:inline">Preview</span>
        </button>
        <span className="mx-1.5 h-5 w-px shrink-0 bg-border" />
        <div ref={rowRef} className="relative flex min-w-0 flex-1 items-center">
          <NavigationMenu
            value={open}
            onValueChange={(value, details) => {
              byHover.current = details.reason === "trigger-hover";
              setOpen(value as string | null);
            }}
            delay={60}
            closeDelay={120}
            alignOffset={lastOffset.current}
          >
            <NavigationMenuList>
              {tabs.map(entry => (
                <NavigationMenuItem key={entry.key} value={entry.key}>
                  <NavigationMenuTrigger ref={element => void (triggers.current[entry.key] = element)} className={cn(tab, groupActive(entry.sections) && tabOn, tabOpen)}>
                    {entry.title}
                    <ChevronDownIcon className="size-3.5 opacity-60 transition-transform duration-150 group-data-popup-open/trigger:rotate-180" />
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <MenuPanel title={entry.title} sections={entry.sections} large={entry.large} isActive={isActive} note={note} columns={layout(entry).columns} width={layout(entry).width} autoFocus={!byHover.current} />
                  </NavigationMenuContent>
                </NavigationMenuItem>
              ))}
            </NavigationMenuList>
          </NavigationMenu>
          {/* Every tab laid out unseen, to know how many fit. */}
          <div ref={measureRef} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex h-0 w-0 overflow-hidden">
            {groups.map(group => <span key={group.key} className={cn(tab, "gap-1.5")}>{group.label}<ChevronDownIcon className="size-3.5" /></span>)}
          </div>
        </div>
        {trash && (
          <Link to={trash.to} aria-label="Trash" className={cn(tab, isActive(trash.to) && tabOn)}>
            <Trash2Icon className={cn("size-4", isActive(trash.to) && "text-brand")} /><span className="hidden xl:inline">Trash</span>
          </Link>
        )}
        {account}
      </div>

      {mobile && (
        <MobileMenu groups={groups} isActive={isActive} note={note} onSearch={() => {
          setMobile(false);
          onSearch();
        }} previewOpen={previewOpen} onPreview={() => {
          setMobile(false);
          onPreview();
        }} trash={trash} account={account} />
      )}
    </div>
  );
}

function matches(item: NavItem, query: string) {
  return item.label.toLowerCase().includes(query.trim().toLowerCase());
}

function ItemLink({ item, active, note, focused, onFocusItem, compact, inMenu }: { item: NavItem, active: boolean, note?: string, focused?: boolean, onFocusItem?(): void, compact?: boolean, inMenu?: boolean }) {
  const className = cn(
    "group/item flex items-center gap-3 rounded-[12px] px-2.5 outline-none focus-visible:bg-foreground/[0.06]",
    compact ? "h-11" : "h-12",
    focused ? "bg-foreground/[0.05]" : "hover:bg-foreground/[0.05]"
  );
  const body = (
    <>
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-[9px] [&_svg]:size-4", active ? "raised text-brand" : "bg-foreground/[0.05] text-muted-foreground group-hover/item:text-foreground")}>{item.icon}</span>
      <span className="grid min-w-0 flex-1 leading-tight">
        <span className={cn("truncate text-sm", active ? "font-semibold" : "font-medium")}>{item.label}</span>
        {note && !compact && <span className="truncate text-xs text-muted-foreground">{note}</span>}
      </span>
    </>
  );
  // In a desktop menu, following the link closes it, even onto the page already open.
  if(inMenu) {
    return <NavigationMenuLink render={<Link to={item.to} />} data-nav-item aria-current={active ? "page" : undefined} onPointerMove={onFocusItem} className={className}>{body}</NavigationMenuLink>;
  }
  return <Link to={item.to} data-nav-item aria-current={active ? "page" : undefined} onPointerMove={onFocusItem} className={className}>{body}</Link>;
}

/** One group's items, in columns, with a filter when there are many. Arrow keys move through the grid. */
function MenuPanel({ title, sections, large, isActive, note, columns, width, autoFocus }: {
  title: string,
  sections: Section[],
  large: boolean,
  isActive(to: string): boolean,
  note(item: NavItem): string | undefined,
  columns: number,
  width: number,
  autoFocus: boolean
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filtered = sections.map(s => ({ ...s, items: s.items.filter(item => matches(item, query)) })).filter(s => s.items.length > 0);
  const flat = filtered.flatMap(s => s.items);
  const total = sections.reduce((n, s) => n + s.items.length, 0);

  useEffect(() => {
    setIndex(0);
  }, [query]);
  useEffect(() => {
    // Opened with a press or a key, a large menu is ready to be typed into.
    if(large && autoFocus) inputRef.current?.focus();
  }, [large, autoFocus]);

  function focusItem(next: number) {
    const clamped = Math.max(0, Math.min(flat.length - 1, next));
    setIndex(clamped);
    const element = gridRef.current?.querySelectorAll<HTMLElement>("[data-nav-item]")[clamped];
    element?.focus({ preventScroll: false });
    element?.scrollIntoView({ block: "nearest" });
  }
  function onKeyDown(event: KeyboardEvent) {
    const focusedInGrid = gridRef.current?.contains(document.activeElement);
    // Items run down each column, so down is the next item and sideways is a whole column.
    const rows = filtered.length === 1 ? Math.ceil(flat.length / columns) : 1;
    const step: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, ArrowRight: rows, ArrowLeft: -rows };
    if(event.key in step) {
      event.preventDefault();
      event.stopPropagation();
      if(!focusedInGrid) return focusItem(event.key === "ArrowUp" ? flat.length - 1 : 0);
      if(event.key === "ArrowUp" && index === 0 && large) {
        inputRef.current?.focus();
        return;
      }
      return focusItem(index + step[event.key]!);
    }
    if(event.key === "Enter" && !focusedInGrid && flat[0]) {
      (gridRef.current?.querySelector("[data-nav-item]") as HTMLElement | null)?.click();
    }
  }

  let position = -1;
  return (
    <div onKeyDown={onKeyDown} style={{ width }} className="flex" aria-label={title}>
      <div className="flex min-w-0 flex-1 flex-col p-2.5">
        {large && (
          <div className="relative mb-1.5">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={`Filter ${total} items…`}
              aria-label={`Filter ${title.toLowerCase()}`}
              className="h-10 w-full rounded-[11px] well pr-12 pl-9 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Kbd className="absolute top-1/2 right-2.5 -translate-y-1/2">esc</Kbd>
          </div>
        )}
        <div ref={gridRef} className={cn("max-h-[min(26rem,calc(100vh-10rem))] overflow-y-auto overscroll-contain", large && "min-h-48")}>
          {flat.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">Nothing matches “{query.trim()}”.</p>}
          {filtered.map((section, s) => (
            <div key={section.label ?? s}>
              {section.label && <p className="eyebrow px-2.5 pt-3 pb-1">{section.label}</p>}
              <div className="grid grid-flow-col gap-x-1 gap-y-0.5" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(section.items.length / columns)}, auto)` }}>
                {section.items.map(item => {
                  position++;
                  const mine = position;
                  return <ItemLink inMenu key={item.key} item={item} active={isActive(pathOf(item.to))} note={note(item)} focused={query !== "" && mine === 0 && !gridRef.current?.contains(document.activeElement)} onFocusItem={() => setIndex(mine)} />;
                })}
              </div>
            </div>
          ))}
        </div>
        {large && (
          <div className="mt-1.5 flex items-center justify-between border-t px-2.5 pt-2 text-xs text-muted-foreground">
            <span>{query ? `${flat.length} of ${total}` : `${total} items`}</span>
            <span className="hidden sm:inline">↑ ↓ ← → to move · ↵ to open</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The phone's menu: everything in one sheet, each group collapsible, with one filter across all of them. */
function MobileMenu({ groups, isActive, note, onSearch, previewOpen, onPreview, trash, account }: {
  groups: NavGroup[],
  isActive(to: string): boolean,
  note(item: NavItem): string | undefined,
  onSearch(): void,
  previewOpen: boolean,
  onPreview(): void,
  trash: { to: string } | null,
  account: ReactNode
}) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => Object.fromEntries(groups.map((g, i) => [g.key, i === 0 || g.items.some(item => isActive(pathOf(item.to)))])));
  const [all, setAll] = useState<Record<string, boolean>>({});
  const many = groups.reduce((n, g) => n + g.items.length, 0) > LARGE;
  return (
    <>
      <div className="fixed inset-x-0 top-14 bottom-0 -z-10 bg-foreground/[0.08] animate-in fade-in-0 duration-150 md:hidden" aria-hidden />
      <div data-menu className="absolute inset-x-2 top-[calc(100%-4px)] flex max-h-[calc(100vh-8rem)] flex-col overflow-hidden rounded-[20px] floating animate-in fade-in-0 slide-in-from-top-1 duration-150 md:hidden">
        <div className="flex flex-col gap-2 overflow-y-auto overscroll-contain p-2.5">
          <button type="button" onClick={onSearch} className="flex h-11 shrink-0 items-center gap-2.5 rounded-[12px] well px-3 text-sm text-muted-foreground"><SearchIcon className="size-4" /> Search…</button>
          <div className="grid shrink-0 grid-cols-2 gap-2">
            <Link to="/" className={cn("flex h-12 items-center gap-2.5 rounded-[13px] px-3.5 text-sm font-medium", isActive("/") ? "bg-foreground text-background" : "bg-foreground/[0.05]")}><HomeIcon className="size-4" /> Dashboard</Link>
            <button type="button" onClick={onPreview} className={cn("flex h-12 items-center gap-2.5 rounded-[13px] px-3.5 text-sm font-medium", previewOpen ? "bg-foreground text-background" : "bg-foreground/[0.05]")}><AppWindowIcon className="size-4" /> Preview</button>
          </div>
          {many && (
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter…" aria-label="Filter" className="h-10 shrink-0 rounded-[11px] well px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" />
          )}
          {groups.map(group => {
            const items = group.items.filter(item => matches(item, query));
            if(items.length === 0) return null;
            const isOpen = query !== "" || expanded[group.key];
            const capped = !query && !all[group.key] && items.length > 6;
            return (
              <div key={group.key} className="shrink-0">
                <button type="button" aria-expanded={isOpen} onClick={() => setExpanded(value => ({ ...value, [group.key]: !value[group.key] }))} className="flex h-10 w-full items-center gap-1.5 rounded-[10px] px-2 text-left">
                  <ChevronDownIcon className={cn("size-3.5 text-muted-foreground transition-transform duration-150", !isOpen && "-rotate-90")} />
                  <span className="eyebrow uppercase tracking-wide">{group.label}</span>
                  <span className="ml-auto rounded-full bg-foreground/[0.06] px-2 text-xs text-muted-foreground">{items.length}</span>
                </button>
                {isOpen && (
                  <div className="flex flex-col">
                    {(capped ? items.slice(0, 6) : items).map(item => <ItemLink key={item.key} item={item} active={isActive(pathOf(item.to))} note={note(item)} compact />)}
                    {capped && <button type="button" onClick={() => setAll(value => ({ ...value, [group.key]: true }))} className="h-10 px-3 text-left text-sm font-medium text-brand">Show all {items.length}</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {(trash || account) && (
          <div className="flex items-center gap-1 border-t p-2">
            {trash && <Link to={trash.to} className="flex h-10 flex-1 items-center gap-2.5 rounded-[10px] px-3 text-sm font-medium hover:bg-foreground/[0.05]"><Trash2Icon className="size-4 text-muted-foreground" /> Trash</Link>}
            {account}
          </div>
        )}
      </div>
    </>
  );
}
