import type { ComponentType, ReactNode } from "react";
import type { AnyConfig } from "../config.ts";
import type { QueryClient } from "../query/index.ts";
import type { AnySchema } from "../schema/types.ts";
import type { Issue } from "../schema/validate.ts";

export interface FieldDescriptor {
  /** Last path segment. */
  name: string,
  path: Array<string | number>,
  label: string,
  description?: string,
  schema: AnySchema,
  /** Validation messages for this field (not its children). */
  errors: string[],
  /** Every validation issue at or below this field, with full paths. */
  issues: Issue[],
  required: boolean,
  readOnly: boolean,
  locale: string,
  /** The content type and document being edited. */
  document: { type: string, id: string | null }
}

export interface Asset {
  id: string,
  url: string,
  filename: string,
  folder: string | null,
  mime: string,
  size: number,
  meta: { width?: number, height?: number, duration?: number, [key: string]: unknown },
  createdAt: string,
  createdBy: string
}

export interface DocumentSummary {
  id: string,
  [key: string]: unknown
}

export interface AdminClient {
  /** Authenticated request to the site's API, relative to `/_vibe/api`. */
  api<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>,
  /** Queries including drafts. */
  query: QueryClient<AnyConfig>,
  upload(file: File, options?: { folder?: string, type?: string, field?: string }): Promise<Asset>,
  assets: {
    list(options?: { folder?: string, search?: string, accept?: string[], limit?: number, offset?: number }): Promise<{ assets: Asset[], total: number, folders: string[] }>,
    get(id: string): Promise<Asset>
  },
  documents: {
    list(type: string, options?: { search?: string, locale?: string, limit?: number }): Promise<{ docs: DocumentSummary[], total: number }>
  },
  /** `cms.plugins.search.rebuild(body)` → `POST /_vibe/plugins/search/rebuild`. */
  plugins: Record<string, Record<string, (body?: unknown) => Promise<unknown>>>,
  /** URL of an uploaded file by asset ID. */
  mediaUrl(id: string): string,
  /** Content type names of this site. */
  types: string[],
  navigate(path: string): void,
  toast(message: string, options?: { type?: "success" | "error" | "info" }): void
}

export interface WidgetContext<T = unknown, O = unknown> {
  value: T,
  onChange(value: T): void,
  options: O,
  field: FieldDescriptor,
  cms: AdminClient
}

export interface MountedWidget<T, O> {
  update(ctx: WidgetContext<T, O>): void,
  unmount(): void
}

/** The framework-neutral widget contract. */
export interface WidgetImpl<T = any, O = any> {
  mount(el: HTMLElement, ctx: WidgetContext<T, O>): MountedWidget<T, O>,
  /** Set by `defineReactWidget`: rendered inside the admin's React tree instead of mounted. */
  react?: ComponentType<WidgetContext<T, O>>
}

// --- Admin plugins -----------------------------------------------------------

export interface DocumentSlotProps {
  type: string,
  id: string | null,
  locale: string,
  value: Record<string, unknown>,
  status: "draft" | "published" | "changed" | null,
  cms: AdminClient
}

export interface NavItem {
  label: string,
  to: string,
  /** An icon name like `"search"` (see the admin's icon set), or a component. */
  icon?: string | ComponentType<{ className?: string }>
}

export interface DocumentAction {
  id: string,
  label: string,
  /** Only for these content types. */
  types?: string[],
  component?: ComponentType<DocumentSlotProps>,
  run?: (props: DocumentSlotProps) => void | Promise<void>
}

export interface DocumentPanel {
  id: string,
  label: string,
  types?: string[],
  component: ComponentType<DocumentSlotProps>
}

export interface ListColumn {
  /** Content type this column applies to. */
  type: string,
  id: string,
  label: string,
  component: ComponentType<{ doc: DocumentSummary, cms: AdminClient }>
}

export interface ListFilter {
  type: string,
  id: string,
  label: string,
  /** Returns a where-condition, or undefined for "no filter". */
  options: Array<{ label: string, value: string }>,
  where: (value: string) => import("../query/index.ts").Condition | undefined
}

export interface FieldDecoratorProps {
  field: FieldDescriptor,
  value: unknown,
  onChange(value: unknown): void,
  cms: AdminClient,
  children: ReactNode
}

export interface FieldDecorator {
  id: string,
  /** Decorate only fields that pass this test. */
  match?: (field: FieldDescriptor) => boolean,
  component: ComponentType<FieldDecoratorProps>
}

export interface Command {
  id: string,
  label: string,
  run: () => void | Promise<void>
}

export interface AdminPage {
  title: string,
  component: ComponentType<{ cms: AdminClient, params: Record<string, string> }>
}

export interface AdminPlugin {
  widgets?: Record<string, WidgetImpl>,
  pages?: Record<string, AdminPage>,
  slots?: {
    nav?: NavItem[],
    "document.sidebar"?: DocumentPanel[],
    "document.actions"?: DocumentAction[],
    "list.columns"?: ListColumn[],
    "list.filters"?: ListFilter[]
  },
  fieldDecorators?: FieldDecorator[],
  commands?: Command[]
}

export type AdminPluginFactory = (context: { cms: AdminClient }) => AdminPlugin;

export function defineAdmin(factory: AdminPluginFactory): AdminPluginFactory {
  return factory;
}

export type { Issue };
