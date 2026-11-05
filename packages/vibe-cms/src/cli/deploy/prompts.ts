import * as clack from "@clack/prompts";

export class Cancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

export interface Option<T> {
  value: T,
  label: string,
  hint?: string
}

/** The wizard's questions and messages, so tests can answer them without a terminal. */
export interface Prompts {
  intro(title: string): void,
  outro(message: string): void,
  note(body: string, title?: string): void,
  info(message: string): void,
  warn(message: string): void,
  success(message: string): void,
  text(options: { message: string, initial?: string, placeholder?: string, validate?: (value: string) => string | undefined }): Promise<string>,
  password(options: { message: string, validate?: (value: string) => string | undefined }): Promise<string>,
  confirm(options: { message: string, initial?: boolean }): Promise<boolean>,
  select<T>(options: { message: string, options: Array<Option<T>>, initial?: T }): Promise<T>,
  spinner(): { start(message: string): void, stop(message: string): void }
}

function answered<T>(value: T): Exclude<T, symbol> {
  if(clack.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

export const clackPrompts: Prompts = {
  intro: title => clack.intro(title),
  outro: message => clack.outro(message),
  note: (body, title) => clack.note(body, title),
  info: message => clack.log.info(message),
  warn: message => clack.log.warn(message),
  success: message => clack.log.success(message),
  text: async options => answered(await clack.text({ ...options, validate: options.validate && (v => options.validate!(v ?? "")) })),
  password: async options => answered(await clack.password({ ...options, validate: options.validate && (v => options.validate!(v ?? "")) })),
  confirm: async options => answered(await clack.confirm(options)),
  select: async <T>(options: { message: string, options: Array<Option<T>>, initial?: T }) => answered(await clack.select<T>({ message: options.message, initialValue: options.initial, options: options.options as never })),
  spinner: () => clack.spinner()
};
