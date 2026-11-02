import type { ComponentType, ReactNode } from "react";
import type { AnyConfig } from "../config.ts";
import type { IconName } from "../icons.ts";
import type { QueryClient } from "../query/index.ts";
import type { AnySchema, DocumentData, JsonValue } from "../schema/types.ts";
import type { DocumentMeta } from "../query/index.ts";
import type { Issue } from "../schema/validate.ts";
import type { ThrowingActionClient } from "../actions/client.ts";
import type { CoreActions } from "../actions/core.ts";

/** The field a widget or field decorator is rendered for. */
export interface FieldDescriptor {
  /** Last path segment. */
  name: string,
  path: Array<string | number>,
  label: string,
  description?: string,
  /** The schema as declared: an optional field's is the `optional` wrapper (see `unwrapOptional`). */
  schema: AnySchema,
  /** Validation messages for this field (not its children). */
  errors: string[],
  /** Every validation issue at or below this field, with full paths. */
  issues: Issue[],
  /** False for `v.optional` fields, which are cleared with `undefined`. */
  required: boolean,
  /** Set for `readOnly` fields and for editors who may not write this locale. */
  readOnly: boolean,
  locale: string,
  /** The content type and document being edited (`id` is null until first saved). */
  document: { type: string, id: string | null }
}

export type { Asset } from "../handler/engine.ts";
import type { Asset } from "../handler/engine.ts";

/** A document as listed by the editor API: its draft data plus ID and metadata. */
export type DocumentSummary = DocumentData & { id: string, $meta: DocumentMeta };

/** The editor's client, given to admin plugins and widgets. Every request carries the editor's credentials. */
export interface AdminClient {
  /**
   * Authenticated request relative to `/_vibe/api`, or to `/_vibe` for paths starting with
   * `/plugins/`. Resolves to the parsed body; throws `ApiError` on a non-2xx answer.
   */
  api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>,
  /** Every CMS action, typed: `cms.actions.documents.publish({ type, id })`. Failures throw an `ApiError` carrying the action error's `tag`. */
  actions: ThrowingActionClient<CoreActions>,
  /** Queries including drafts. */
  query: QueryClient<AnyConfig>,
  /** With `type` and `field`, the upload is checked against that asset field. */
  upload(file: File, options?: { folder?: string, type?: string, field?: string }): Promise<Asset>,
  /** The media library. */
  assets: {
    list(options?: { folder?: string, search?: string, accept?: string[], limit?: number, offset?: number }): Promise<{ assets: Asset[], total: number, folders: string[] }>,
    get(id: string): Promise<Asset>
  },
  documents: {
    /** Drafts of a content type, as the editor's lists show them. */
    list(type: string, options?: { search?: string, locale?: string, limit?: number }): Promise<{ docs: DocumentSummary[], total: number }>
  },
  /** `cms.plugins.search.rebuild(body)` → `POST /_vibe/plugins/search/rebuild` with a JSON body. Always POST, one path segment. */
  plugins: Record<string, Record<string, (body?: unknown) => Promise<unknown>>>,
  /** URL of an uploaded file by asset ID. */
  mediaUrl(id: string): string,
  /** Content type names of this site. */
  types: string[],
  /** Opens an editor path without `/_vibe/admin`: `/content/post/new`, `/p/<plugin>/…`. */
  navigate(path: string): void,
  /** Shows a notification. */
  toast(message: string, options?: { type?: "success" | "error" | "info" }): void
}

/** What a widget renders from. */
export interface WidgetContext<T = unknown, O = unknown> {
  /** `undefined` for an empty optional field; on a draft that doesn't validate, possibly any stored JSON. */
  value: T,
  /** `undefined` clears an optional field. */
  onChange(value: T): void,
  /** What the schema passed to the widget's descriptor factory. */
  options: O,
  field: FieldDescriptor,
  cms: AdminClient
}

/** Returned by `mount`: `update` runs on every render of the form, `unmount` when the field goes away. */
export interface MountedWidget<T, O> {
  update(ctx: WidgetContext<T, O>): void,
  unmount(): void
}

/** The framework-neutral widget contract: the default export of a widget's `*.admin.*` file. See `vibe-cms docs widgets`. */
export interface WidgetImpl<T = any, O = any> {
  mount(el: HTMLElement, ctx: WidgetContext<T, O>): MountedWidget<T, O>,
  /** Set by `defineReactWidget`: rendered inside the admin's React tree instead of mounted. */
  react?: ComponentType<WidgetContext<T, O>>
}

// --- Admin plugins -----------------------------------------------------------

/** Props of `document.sidebar` and `document.actions` components. */
export interface DocumentSlotProps {
  type: string,
  /** Null for a new, unsaved document. */
  id: string | null,
  locale: string,
  /** The form's current data, including unsaved edits, in the stored shape. */
  value: DocumentData,
  /** Null for a new document. */
  status: "draft" | "published" | "changed" | null,
  cms: AdminClient
}

/** A sidebar link. */
export interface NavItem {
  label: string,
  /** Relative to the plugin: `"/"` links to `/_vibe/admin/p/<plugin>`. */
  to: string,
  /** An icon from the editor's set, or your own component. */
  icon?: IconName | ComponentType<{ className?: string }>
}

/** A document header item: a button running `run`, or your own `component`. */
export interface DocumentAction {
  id: string,
  label: string,
  /** Only for these content types. */
  types?: string[],
  /** Rendered instead of the button. */
  component?: ComponentType<DocumentSlotProps>,
  run?: (props: DocumentSlotProps) => void | Promise<void>
}

/** A titled panel beside the document form. */
export interface DocumentPanel {
  id: string,
  label: string,
  /** Only for these content types. */
  types?: string[],
  component: ComponentType<DocumentSlotProps>
}

/** A column in one content type's document list. */
export interface ListColumn {
  /** Content type this column applies to. */
  type: string,
  id: string,
  label: string,
  component: ComponentType<{ doc: DocumentSummary, cms: AdminClient }>
}

/** Declared for list filters; the editor doesn't show them yet. */
export interface ListFilter {
  type: string,
  id: string,
  label: string,
  /** Returns a where-condition, or undefined for "no filter". */
  options: Array<{ label: string, value: string }>,
  where: (value: string) => import("../query/index.ts").Condition | undefined
}

/** Props of a field decorator: render `children` to keep the field's own control. */
export interface FieldDecoratorProps {
  field: FieldDescriptor,
  value: JsonValue | undefined,
  onChange(value: JsonValue | undefined): void,
  cms: AdminClient,
  children: ReactNode
}

/** Wraps the control of matching fields, in every content type and at any depth. */
export interface FieldDecorator {
  id: string,
  /** Decorate only fields that pass this test. Every field when omitted. */
  match?: (field: FieldDescriptor) => boolean,
  component: ComponentType<FieldDecoratorProps>
}

/** An entry in the editor's command menu. If `run` throws, its message is shown as an error toast. */
export interface Command {
  id: string,
  label: string,
  run: () => void | Promise<void>
}

/** An editor page, registered under a path relative to the plugin. */
export interface AdminPage {
  title: string,
  /** `params` holds the page key's `:name` segments. */
  component: ComponentType<{ cms: AdminClient, params: Record<string, string> }>
}

/**
 * What a plugin's admin entry returns. Page keys and nav `to` are relative to the
 * plugin: the editor serves them under `/_vibe/admin/p/<plugin>`. See
 * `vibe-cms docs admin-extensions`.
 */
export interface AdminPlugin {
  /** Unused: widgets load from their descriptor (`defineWidget`) wherever a schema uses them. */
  widgets?: Record<string, WidgetImpl>,
  /** Keyed by path, `:param` segments allowed: `"/"` is `/_vibe/admin/p/<plugin>`. */
  pages?: Record<string, AdminPage>,
  slots?: {
    nav?: NavItem[],
    "document.sidebar"?: DocumentPanel[],
    "document.actions"?: DocumentAction[],
    "list.columns"?: ListColumn[],
    /** Not shown by the editor yet. */
    "list.filters"?: ListFilter[]
  },
  fieldDecorators?: FieldDecorator[],
  commands?: Command[]
}

/** An admin entry: called once when the editor loads, with the editor's client. */
export type AdminPluginFactory = (context: { cms: AdminClient }) => AdminPlugin;

/**
 * Defines a plugin's admin entry. Default-export the result from a `*.admin.tsx`
 * file named by the descriptor's `admin`. See `vibe-cms docs admin-extensions`.
 */
export function defineAdmin(factory: AdminPluginFactory): AdminPluginFactory {
  return factory;
}

export type { Issue };
