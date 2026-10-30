import Image from "@tiptap/extension-image";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  BoldIcon,
  CodeIcon,
  Heading2Icon,
  Heading3Icon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  QuoteIcon,
  Redo2Icon,
  StrikethroughIcon,
  UnderlineIcon,
  Undo2Icon
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AdminClient } from "vibe-cms/admin";
import { defineReactWidget } from "vibe-cms/admin/react";
import { Button, cn, Input, MediaLibraryDialog, Popover, PopoverContent, PopoverTrigger, Separator, Toggle } from "vibe-cms/admin/ui";
import type { RichEditorOptions } from "./index.ts";
import type { Block, InlineNode, Mark, RichTextDoc, TextNode } from "./schema.ts";

/** Internal links are stored as refs; in the editor they ride on the link mark as `vibe:<type>/<id>`. */
const REF = /^vibe:([\w-]+)\/([\w-]+)$/;

const ImageBlock = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      assetId: { default: null }
    };
  }
});

// --- Conversion ---------------------------------------------------------------------

function inlineToTiptap(nodes: InlineNode[]): JSONContent[] {
  const out: JSONContent[] = [];
  function text(node: TextNode, extra: JSONContent["marks"] = []) {
    const marks = [...(node.marks ?? []).map(type => ({ type })), ...extra];
    node.text.split("\n").forEach((part, i) => {
      if(i > 0) out.push({ type: "hardBreak" });
      if(part) out.push({ type: "text", text: part, ...(marks.length ? { marks } : {}) });
    });
  }
  for(const node of nodes) {
    if(node.kind === "link") {
      const href = node.to ? `vibe:${node.to.type}/${node.to.id}` : node.href ?? "";
      for(const child of node.children) text(child, [{ type: "link", attrs: { href } }]);
    } else {
      text(node);
    }
  }
  return out;
}

export function toTiptap(doc: RichTextDoc | undefined, mediaUrl: (id: string) => string): JSONContent {
  // Content written before the field became rich text (a plain string) opens as paragraphs.
  const blocks: RichTextDoc = Array.isArray(doc) ? doc
    : typeof doc === "string" ? (doc as string).split(/\n{2,}/).map(text => ({ kind: "p", children: [{ kind: "text", text }] }))
      : [];
  const content = blocks.map((block): JSONContent => {
    switch(block.kind) {
      case "p": return { type: "paragraph", content: inlineToTiptap(block.children) };
      case "h": return { type: "heading", attrs: { level: block.level }, content: inlineToTiptap(block.children) };
      case "quote": return { type: "blockquote", content: [{ type: "paragraph", content: inlineToTiptap(block.children) }] };
      case "list": return {
        type: block.ordered ? "orderedList" : "bulletList",
        content: block.items.map(item => ({ type: "listItem", content: [{ type: "paragraph", content: inlineToTiptap(item) }] }))
      };
      case "image": return { type: "image", attrs: { assetId: block.asset.asset, alt: block.asset.alt ?? null, src: mediaUrl(block.asset.asset) } };
    }
  });
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

const knownMarks = new Set<Mark>(["bold", "italic", "underline", "strike", "code"]);

function inlineFromTiptap(nodes: JSONContent[] = []): InlineNode[] {
  const out: InlineNode[] = [];
  for(const node of nodes) {
    let text: string;
    if(node.type === "text") text = node.text ?? "";
    else if(node.type === "hardBreak") text = "\n";
    else continue;
    const marks = (node.marks ?? []).map(m => m.type as Mark).filter(m => knownMarks.has(m));
    const href = node.marks?.find(m => m.type === "link")?.attrs?.href as string | undefined;
    const leaf: TextNode = { kind: "text", text, ...(marks.length ? { marks } : {}) };
    const last = out[out.length - 1];
    if(href) {
      const ref = REF.exec(href);
      const target = ref ? { to: { type: ref[1]!, id: ref[2]! } } : { href };
      const sameLink = last?.kind === "link" && (ref ? last.to?.id === ref[2] : last.href === href);
      if(sameLink) last.children.push(leaf);
      else out.push({ kind: "link", ...target, children: [leaf] });
    } else if(last?.kind === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(leaf.marks ?? [])) {
      last.text += text;
    } else {
      out.push(leaf);
    }
  }
  return out;
}

function firstParagraph(node: JSONContent): JSONContent[] {
  return (node.content ?? []).flatMap(child => (child.type === "paragraph" ? child.content ?? [] : []));
}

export function fromTiptap(json: JSONContent): RichTextDoc {
  const blocks: Block[] = [];
  for(const node of json.content ?? []) {
    switch(node.type) {
      case "paragraph": blocks.push({ kind: "p", children: inlineFromTiptap(node.content) }); break;
      case "heading": blocks.push({ kind: "h", level: Math.min(4, Math.max(2, Number(node.attrs?.level ?? 2))), children: inlineFromTiptap(node.content) }); break;
      case "blockquote": blocks.push({ kind: "quote", children: inlineFromTiptap(firstParagraph(node)) }); break;
      case "bulletList":
      case "orderedList":
        blocks.push({ kind: "list", ordered: node.type === "orderedList", items: (node.content ?? []).map(item => inlineFromTiptap(firstParagraph(item))) });
        break;
      case "image":
        if(node.attrs?.assetId) {
          blocks.push({ kind: "image", asset: { asset: node.attrs.assetId as string, ...(node.attrs.alt ? { alt: node.attrs.alt as string } : {}) } });
        }
        break;
    }
  }
  // An editor with nothing in it is an empty document.
  if(blocks.length === 1 && blocks[0]!.kind === "p" && blocks[0]!.children.length === 0) return [];
  return blocks;
}

// --- Toolbar ----------------------------------------------------------------------

function Tool({ pressed, onClick, label, children, disabled }: { pressed?: boolean, onClick(): void, label: string, children: ReactNode, disabled?: boolean }) {
  return (
    <Toggle size="sm" pressed={pressed ?? false} onPressedChange={() => onClick()} aria-label={label} title={label} disabled={disabled}>
      {children}
    </Toggle>
  );
}

function LinkTool({ editor, cms }: { editor: Editor, cms: AdminClient }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Array<{ type: string, id: string, title: string }>>([]);
  const active = editor.isActive("link");

  useEffect(() => {
    if(!open) return;
    setUrl((editor.getAttributes("link").href as string | undefined) ?? "");
  }, [open]);

  useEffect(() => {
    if(!open || search.length < 2) return setResults([]);
    let cancelled = false;
    const timer = setTimeout(async () => {
      const found = await Promise.all(cms.types.map(async type => {
        const { docs } = await cms.documents.list(type, { search, limit: 4 });
        return docs.map(doc => ({
          type,
          id: doc.id,
          title: String(Object.values(doc).find(value => typeof value === "string" && value !== doc.id) ?? doc.id)
        }));
      }));
      if(!cancelled) setResults(found.flat());
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, open]);

  function apply(href: string) {
    const chain = editor.chain().focus().extendMarkRange("link");
    if(href) chain.setLink({ href }).run();
    else chain.unsetLink().run();
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Toggle size="sm" pressed={active} aria-label="Link" title="Link"><LinkIcon /></Toggle>} />
      <PopoverContent className="w-80" align="start">
        <form className="flex gap-2" onSubmit={e => {
          e.preventDefault();
          apply(url.trim());
        }}>
          <Input value={url.startsWith("vibe:") ? "" : url} onChange={e => setUrl(e.target.value)} placeholder={url.startsWith("vibe:") ? "Linked to a document" : "https://…"} autoFocus />
          <Button type="submit" size="sm">Apply</Button>
        </form>
        <Separator />
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="…or search documents to link" />
        {results.length > 0 && (
          <ul className="-mx-1 max-h-48 overflow-y-auto">
            {results.map(r => (
              <li key={r.id}>
                <button type="button" className="flex w-full items-center justify-between gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => apply(`vibe:${r.type}/${r.id}`)}>
                  <span className="truncate">{r.title}</span>
                  <span className="text-xs text-muted-foreground">{r.type}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {active && <Button variant="ghost" size="sm" className="w-fit text-destructive" onClick={() => apply("")}>Remove link</Button>}
      </PopoverContent>
    </Popover>
  );
}

// --- Widget -----------------------------------------------------------------------

export default defineReactWidget<RichTextDoc, RichEditorOptions>(({ value, onChange, options, field, cms }) => {
  const full = options.toolbar !== "minimal";
  const [libraryOpen, setLibraryOpen] = useState(false);
  const lastEmitted = useRef<string>(JSON.stringify(value ?? []));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: full ? { levels: [2, 3, 4] } : false,
        bulletList: full ? {} : false,
        orderedList: full ? {} : false,
        blockquote: full ? {} : false,
        codeBlock: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true, protocols: ["vibe"], isAllowedUri: (url, ctx) => url.startsWith("vibe:") || ctx.defaultValidate(url) }
      }),
      ImageBlock.configure({ inline: false })
    ],
    content: toTiptap(value, cms.mediaUrl),
    editable: !field.readOnly,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        class: "prose-vibe min-h-40 px-3 py-2.5 outline-none",
        "aria-label": field.label,
        id: `field-${field.path.join("-")}`
      }
    },
    onUpdate({ editor: e }) {
      const doc = fromTiptap(e.getJSON());
      lastEmitted.current = JSON.stringify(doc);
      onChangeRef.current(doc);
    }
  });

  // Outside changes (restoring a version, discarding edits) replace the content.
  useEffect(() => {
    if(!editor) return;
    const incoming = JSON.stringify(value ?? []);
    if(incoming === lastEmitted.current) return;
    lastEmitted.current = incoming;
    editor.commands.setContent(toTiptap(value, cms.mediaUrl), { emitUpdate: false });
  }, [value, editor]);

  useEffect(() => {
    editor?.setEditable(!field.readOnly);
  }, [field.readOnly, editor]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"),
      italic: e.isActive("italic"),
      underline: e.isActive("underline"),
      strike: e.isActive("strike"),
      code: e.isActive("code"),
      h2: e.isActive("heading", { level: 2 }),
      h3: e.isActive("heading", { level: 3 }),
      bullet: e.isActive("bulletList"),
      ordered: e.isActive("orderedList"),
      quote: e.isActive("blockquote"),
      canUndo: e.can().undo(),
      canRedo: e.can().redo()
    })
  });

  if(!editor || !state) return null;
  function chain() {
    return editor!.chain().focus();
  }

  return (
    <div
      className={cn(
        // Radii nest: 4px of well around a 10px toolbar, 2px of toolbar around 8px tools.
        "rounded-[14px] well p-1 transition-shadow focus-within:ring-3 focus-within:ring-ring/50",
        field.errors.length > 0 && "ring-1 ring-destructive"
      )}
    >
      {!field.readOnly && (
        <div className="flex flex-wrap items-center gap-0.5 rounded-[10px] raised p-0.5">
          <Tool label="Bold" pressed={state.bold} onClick={() => chain().toggleBold().run()}><BoldIcon /></Tool>
          <Tool label="Italic" pressed={state.italic} onClick={() => chain().toggleItalic().run()}><ItalicIcon /></Tool>
          <Tool label="Underline" pressed={state.underline} onClick={() => chain().toggleUnderline().run()}><UnderlineIcon /></Tool>
          <Tool label="Strikethrough" pressed={state.strike} onClick={() => chain().toggleStrike().run()}><StrikethroughIcon /></Tool>
          <Tool label="Code" pressed={state.code} onClick={() => chain().toggleCode().run()}><CodeIcon /></Tool>
          <LinkTool editor={editor} cms={cms} />
          {full && (
            <>
              <Separator orientation="vertical" className="mx-1 h-5" />
              <Tool label="Heading" pressed={state.h2} onClick={() => chain().toggleHeading({ level: 2 }).run()}><Heading2Icon /></Tool>
              <Tool label="Subheading" pressed={state.h3} onClick={() => chain().toggleHeading({ level: 3 }).run()}><Heading3Icon /></Tool>
              <Tool label="Bulleted list" pressed={state.bullet} onClick={() => chain().toggleBulletList().run()}><ListIcon /></Tool>
              <Tool label="Numbered list" pressed={state.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrderedIcon /></Tool>
              <Tool label="Quote" pressed={state.quote} onClick={() => chain().toggleBlockquote().run()}><QuoteIcon /></Tool>
              <Tool label="Image" onClick={() => setLibraryOpen(true)}><ImageIcon /></Tool>
            </>
          )}
          <div className="ml-auto flex">
            <Tool label="Undo" disabled={!state.canUndo} onClick={() => chain().undo().run()}><Undo2Icon /></Tool>
            <Tool label="Redo" disabled={!state.canRedo} onClick={() => chain().redo().run()}><Redo2Icon /></Tool>
          </div>
        </div>
      )}
      <EditorContent editor={editor} />
      <MediaLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        accept={["image/*"]}
        onSelect={asset => {
          chain().setImage({ src: asset.url, alt: "" }).updateAttributes("image", { assetId: asset.id }).run();
          setLibraryOpen(false);
        }}
      />
      <style>{css}</style>
    </div>
  );
});

const css = `
.prose-vibe { font-size: 0.9375rem; line-height: 1.65; }
.prose-vibe > * + * { margin-top: 0.75em; }
.prose-vibe h2 { font-size: 1.35em; font-weight: 600; line-height: 1.3; margin-top: 1.2em; }
.prose-vibe h3 { font-size: 1.15em; font-weight: 600; margin-top: 1em; }
.prose-vibe h4 { font-weight: 600; }
.prose-vibe ul { list-style: disc; padding-left: 1.4em; }
.prose-vibe ol { list-style: decimal; padding-left: 1.4em; }
.prose-vibe blockquote { border-left: 3px solid var(--border); padding-left: 0.9em; color: var(--muted-foreground); }
.prose-vibe code { font-family: ui-monospace, monospace; font-size: 0.875em; background: var(--muted); border-radius: 4px; padding: 0.1em 0.3em; }
.prose-vibe a { color: var(--primary); text-decoration: underline; text-underline-offset: 2px; }
.prose-vibe a[href^="vibe:"] { text-decoration-style: dashed; }
.prose-vibe img { max-height: 20rem; border-radius: 0.5rem; }
.prose-vibe img.ProseMirror-selectednode { outline: 2px solid var(--ring); }
.prose-vibe p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--muted-foreground); float: left; height: 0; pointer-events: none; }
`;
