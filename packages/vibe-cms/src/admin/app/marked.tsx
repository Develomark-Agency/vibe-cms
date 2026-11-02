/** `text` with the parts between \u0001 and \u0002 (the server's snippet markers) highlighted. */
export function Marked({ text }: { text: string }) {
  return <>{text.split(/(\u0001[^\u0002]*\u0002)/).map((part, i) => part.startsWith("\u0001")
    ? <mark key={i} className="rounded-[3px] bg-primary/15 text-foreground">{part.slice(1, -1)}</mark>
    : part)}</>;
}

/** `title` with each word that starts with a query word highlighted, as the search matched it. */
export function markTitle(title: string, query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return title.replace(/[\p{L}\p{N}]+/gu, token => {
    const word = words.find(w => token.toLowerCase().startsWith(w));
    return word ? `\u0001${token.slice(0, word.length)}\u0002${token.slice(word.length)}` : token;
  });
}
