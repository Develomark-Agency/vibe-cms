# Admin extensions

What a plugin's admin entry can add to the editor: pages, nav links, document sidebar panels and actions, list columns, commands and field decorators, plus the `cms` client they all get.

An admin entry is a `*.admin.tsx` file whose default export is `defineAdmin(({ cms }) => ({ … }))`, named by the descriptor's `admin: () => import("./plugin.admin.tsx")` (`vibe-cms docs plugins`). Everything it returns is a React component or plain data. The editor is a React app, so components render inside it and can use the editor's components from `vibe-cms/admin/ui` and Tailwind utility classes.

| Key | Adds | Component props |
|---|---|---|
| `pages` | Editor pages at `/_vibe/admin/p/<plugin>/…` | `{ cms, params }` |
| `slots.nav` | Sidebar links to those pages | none (data: `label`, `to`, `icon`) |
| `slots["document.sidebar"]` | A panel beside the document form | `DocumentSlotProps` |
| `slots["document.actions"]` | A button (or your component) in the document header | `DocumentSlotProps` |
| `slots["list.columns"]` | A column in a content type's list | `{ doc, cms }` |
| `commands` | Entries in the command menu (⌘K, or ⌘J when the editor is inside the panel) | none (data: `id`, `label`, `run`) |
| `fieldDecorators` | A wrapper around matching fields' controls | `FieldDecoratorProps` |

Pages and nav are covered with their URLs in `vibe-cms docs plugin-routes`. `slots["list.filters"]` is in the types but the editor doesn't show filters yet. Custom field inputs are widgets, not plugins: see `vibe-cms docs widgets`.

The `editor` plugin in `examples/plugins` uses every slot:

```tsx
// examples/plugins/src/editor/plugin.admin.tsx
export default defineAdmin(({ cms }) => ({
  slots: {
    "document.sidebar": [{ id: "words", label: "Words", types: ["post"], component: WordsPanel }],
    // An action with `run` is a header button; give `component` instead to render your own.
    "document.actions": [{
      id: "copy-id",
      label: "Copy ID",
      types: ["post"],
      run: async ({ id }) => {
        if(!id) return cms.toast("Save the post first", { type: "error" });
        await navigator.clipboard.writeText(id);
        cms.toast("Copied", { type: "success" });
      }
    }],
    "list.columns": [{ type: "post", id: "pinned", label: "Pinned", component: PinnedCell }]
  },
  // Shown in the editor's command menu.
  commands: [{
    id: "editor.new-post",
    label: "New post",
    run: () => cms.navigate("/content/post/new")
  }],
  fieldDecorators: [{
    id: "remaining",
    match: field => maxLength(field.schema) !== undefined,
    component: Remaining
  }]
}));
```

## Document panels and actions

Both take `types` to show only on some content types (all when omitted). Their props, `DocumentSlotProps`:

| Prop | |
|---|---|
| `type`, `id` | The content type, and the document ID (`null` for a new, unsaved document) |
| `locale` | The language being edited |
| `value` | The form's current data, including unsaved edits |
| `status` | `"draft"`, `"published"`, `"changed"`, or `null` when new |
| `cms` | The editor's client |

```tsx
// examples/plugins/src/editor/plugin.admin.tsx
// document.sidebar: a panel next to the form. `value` is the form's current (unsaved) data.
function WordsPanel({ value }: DocumentSlotProps) {
  return <p>{typeof value.wordCount === "number" ? `${value.wordCount} words` : "Counted on save"}</p>;
}
```

`value` is the stored draft shape as plain JSON (`DocumentData`): assets are `{ asset, … }` references and refs are IDs. A field derived by a server hook updates when the document is saved.

## List columns

`type` is required: a column belongs to one content type's list. The component gets the row's `doc` (its draft data plus `id` and `$meta`) and `cms`.

## Commands

A command's `run` may be async; if it throws, the editor shows the message as an error toast.

## Field decorators

A decorator wraps the control of every field its `match` accepts (every field when `match` is omitted), in every content type, including fields inside objects and arrays. Render `children` to keep the original control. When several decorators match, the first one registered wraps the control and the next wraps that.

```tsx
// examples/plugins/src/editor/plugin.admin.tsx
// fieldDecorators: wraps a field's control. Render `children` to keep the control itself.
function Remaining({ field, value, children }: FieldDecoratorProps) {
  const max = maxLength(field.schema)!;
  return <div>{children}<small>{max - (typeof value === "string" ? value.length : 0)} characters left</small></div>;
}
```

`field.schema` is the field as declared: for a `v.optional(…)` field it's the optional wrapper, so unwrap it with `unwrapOptional` from `vibe-cms/schema` before reading options like `max`. The other `field` properties are `name`, `path`, `label`, `description`, `errors` (this field's messages), `issues` (everything under it), `required`, `readOnly`, `locale` and `document` (`{ type, id }`).

## The `cms` client

Every component and the factory itself get `cms`, an `AdminClient` that sends the editor's credentials:

| Member | Does |
|---|---|
| `actions` | Every CMS action, typed: `cms.actions.documents.publish({ type, id })`. Throws `ApiError` (with the action error's `tag`) on failure |
| `query` | The query API, including drafts: `cms.query.query(collection, { drafts: true })` |
| `api(path, init?)` | A request relative to `/_vibe/api`, or to `/_vibe` for paths starting with `/plugins/`. `init.json` sends a JSON body |
| `plugins.<name>.<route>(body?)` | `POST /_vibe/plugins/<name>/<route>` with a JSON body |
| `upload(file, { folder?, type?, field? })` | Uploads to the media library. With `type` and `field`, it's checked against that asset field |
| `assets.list(…)`, `assets.get(id)` | The media library |
| `documents.list(type, …)` | Drafts of a content type |
| `mediaUrl(id)` | An uploaded file's URL |
| `types` | The site's content type names |
| `navigate(path)` | Opens an editor path, like `/content/post/new` or `/p/<plugin>/…` |
| `toast(message, { type? })` | A notification: `"success"`, `"error"` or `"info"` |

`cms.query` has no collection objects of its own: import them from the config (`config.schemas.post`), which the editor has loaded anyway.

## Components

`vibe-cms/admin/ui` exports the editor's own components (Button, Input, Textarea, Label, Badge, Switch, Checkbox, Card, Dialog, Popover, Select, Tooltip, DropdownMenu, ToggleGroup, Command and more, plus `MediaLibraryDialog`, `AssetPreview` and `cn`), so extensions match the editor and follow its light and dark themes.

```tsx
// examples/plugins/src/widgets/rating.admin.tsx
import { Button } from "vibe-cms/admin/ui";
```
