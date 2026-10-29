/**
 * Icon names for collections (`collections.<type>.icon`) and plugin nav items.
 * A plain list so the config can name icons without importing the icon library;
 * the editor maps each name to a component and must cover every one.
 */
export const iconNames = [
  "book-open", "box", "briefcase", "building", "calendar", "chart-bar", "file", "file-text", "film", "folder", "globe",
  "heart", "home", "image", "inbox", "layers", "layout", "link", "mail", "map-pin", "megaphone", "menu",
  "message-square", "music", "newspaper", "package", "palette", "quote", "search", "settings", "shopping-bag",
  "sparkles", "star", "tag", "user", "user-round", "users", "wrench"
] as const;

export type IconName = typeof iconNames[number];
