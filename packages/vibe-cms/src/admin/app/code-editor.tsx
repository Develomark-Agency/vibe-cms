import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter } from "@codemirror/lint";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import type { TextKind } from "../../text-files.ts";
import { cn } from "../lib/utils.ts";

/*
 * Loaded on demand (it's most of the text editor's weight). Colours come from
 * the --code-* tokens and the theme tokens in styles.css, so it follows light
 * and dark mode like everything else.
 */

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "10px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)", borderLeftWidth: "1.5px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "color-mix(in oklch, var(--muted-foreground) 55%, transparent)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--foreground) 4%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklch, var(--code-property) 24%, transparent) !important"
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in oklch, var(--foreground) 12%, transparent)", outline: "none" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--well)", border: "none", color: "var(--muted-foreground)", borderRadius: "4px" },
  ".cm-tooltip": { backgroundColor: "var(--popover)", color: "var(--popover-foreground)", border: "none", borderRadius: "10px", boxShadow: "var(--shadow-float)", overflow: "hidden" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "color-mix(in oklch, var(--foreground) 8%, transparent)", color: "inherit" },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--foreground)", borderColor: "var(--border)" },
  ".cm-panels input, .cm-panels button": { fontFamily: "var(--font-sans)", fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--well)", border: "none", borderRadius: "6px", boxShadow: "var(--shadow-well)", padding: "3px 6px" },
  ".cm-button": { backgroundImage: "linear-gradient(to bottom, var(--raised-top), var(--raised-bottom))", border: "none", borderRadius: "6px", boxShadow: "var(--shadow-raised)", color: "var(--foreground)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklch, var(--code-number) 25%, transparent)" },
  ".cm-searchMatch-selected": { backgroundColor: "color-mix(in oklch, var(--code-number) 45%, transparent)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--destructive)", textUnderlineOffset: "3px" },
  ".cm-diagnostic": { padding: "6px 10px", borderLeft: "none" },
  ".cm-diagnostic-error": { color: "var(--destructive)" }
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.bool, tags.null, tags.operatorKeyword], color: "var(--code-keyword)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--code-string)" },
  { tag: [tags.number, tags.integer, tags.float], color: "var(--code-number)" },
  { tag: [tags.propertyName, tags.attributeName, tags.definition(tags.variableName), tags.tagName], color: "var(--code-property)" },
  { tag: [tags.comment, tags.meta, tags.processingInstruction], color: "var(--code-comment)", fontStyle: "italic" },
  { tag: [tags.punctuation, tags.bracket, tags.separator], color: "var(--muted-foreground)" },
  { tag: tags.heading, fontWeight: "600", color: "var(--foreground)" },
  { tag: tags.heading1, fontSize: "1.15em" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--code-link)", textDecoration: "underline", textUnderlineOffset: "3px" },
  { tag: tags.monospace, color: "var(--code-string)" },
  { tag: [tags.quote, tags.contentSeparator], color: "var(--muted-foreground)" }
]);

/** Quoted fields, numbers and separators; enough to make columns readable. */
function csvLanguage(delimiter: string) {
  return StreamLanguage.define<{ quoted: boolean }>({
    startState: () => ({ quoted: false }),
    token(stream, state) {
      if(state.quoted) {
        while(!stream.eol()) {
          if(stream.next() === "\"") {
            if(stream.peek() === "\"") stream.next();
            else {
              state.quoted = false;
              break;
            }
          }
        }
        return "string";
      }
      if(stream.eat("\"")) {
        state.quoted = true;
        return "string";
      }
      if(stream.eat(delimiter)) return "separator";
      if(stream.match(/^-?\d+(\.\d+)?(?=[,\t;]|$)/)) return "number";
      stream.next();
      while(!stream.eol() && stream.peek() !== delimiter && stream.peek() !== "\"") stream.next();
      return null;
    },
    tokenTable: { separator: tags.separator }
  });
}

/** Each language loads on its own, so opening a Markdown file doesn't fetch the HTML and JavaScript parsers. */
async function languageFor(kind: TextKind, delimiter: string): Promise<Extension[]> {
  switch(kind) {
    // Pasting a URL over a selection makes it a [selection](url) link.
    case "markdown": return [(await import("@codemirror/lang-markdown")).markdown({ pasteURLAsLink: true }), EditorView.lineWrapping];
    case "json": {
      const { json, jsonParseLinter } = await import("@codemirror/lang-json");
      return [json(), linter(jsonParseLinter()), lintGutter()];
    }
    case "yaml": return [(await import("@codemirror/lang-yaml")).yaml()];
    case "xml": return [(await import("@codemirror/lang-xml")).xml()];
    case "css": return [(await import("@codemirror/lang-css")).css()];
    case "javascript": return [(await import("@codemirror/lang-javascript")).javascript({ typescript: true })];
    case "html": return [(await import("@codemirror/lang-html")).html()];
    case "csv": return [csvLanguage(delimiter)];
    default: return [EditorView.lineWrapping];
  }
}

export default function CodeEditor({ value, kind, delimiter = ",", readOnly, autoFocus, onChange, onSave, className }: {
  value: string,
  kind: TextKind,
  delimiter?: string,
  readOnly?: boolean,
  autoFocus?: boolean,
  onChange?(value: string): void,
  onSave?(): void,
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null);
  // Latest callbacks without rebuilding the editor (and losing its history) on every render.
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };

  useEffect(() => {
    // Plain text first; the language swaps in once its pack has loaded.
    const language = new Compartment();
    const extensions: Extension[] = [
      theme,
      syntaxHighlighting(highlight),
      language.of([]),
      EditorView.contentAttributes.of({ "aria-label": "File contents" })
    ];
    if(readOnly) {
      extensions.push(EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping);
    } else {
      // basicSetup brings history, bracket auto-closing and matching, folding, search and autocompletion.
      extensions.unshift(basicSetup);
      extensions.push(
        keymap.of([
          indentWithTab,
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              callbacks.current.onSave?.();
              return true;
            }
          }
        ]),
        EditorView.updateListener.of(update => {
          if(update.docChanged) callbacks.current.onChange?.(update.state.doc.toString());
        })
      );
    }
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: value, extensions }) });
    if(autoFocus) view.focus();
    let live = true;
    void languageFor(kind, delimiter).then(loaded => {
      if(live) view.dispatch({ effects: language.reconfigure(loaded) });
    });
    return () => {
      live = false;
      view.destroy();
    };
    // The document is the editor's own once mounted; remount (with a key) to load different content.
  }, [kind, delimiter, readOnly]);

  return <div ref={host} className={cn("min-h-0 overflow-hidden", className)} />;
}
