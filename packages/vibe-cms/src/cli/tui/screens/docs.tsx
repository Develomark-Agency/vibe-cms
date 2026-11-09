import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { loadTopics, type Topic } from "../../docs.ts";
import { useNav } from "../app.tsx";
import { useSticky } from "../system.ts";
import { markdownLines } from "../text.ts";
import { accent, List, Spinner, TextInput, Title, useHints, useKeys, useSize, Viewer, type ListItem } from "../ui.tsx";

interface Hit {
  topic: Topic,
  /** The line in the topic's body. */
  line: number,
  text: string
}

/** Lines mentioning every word, like `vibe-cms docs search`, with where each is. */
function find(topics: Topic[], query: string): Hit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if(!terms.length) return [];
  const hits: Hit[] = [];
  for(const topic of topics) {
    topic.body.split("\n").forEach((text, line) => {
      const lower = text.toLowerCase();
      if(terms.every(term => lower.includes(term))) hits.push({ topic, line, text: text.trim() });
    });
  }
  return hits;
}

export function DocsScreen() {
  const nav = useNav();
  const { width, height } = useSize();
  const [topics, setTopics] = useState<Topic[]>();
  const [current, setCurrent] = useState<Topic>();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useSticky("docs:query", "");
  const hits = useMemo(() => topics ? find(topics, query).slice(0, 200) : [], [topics, query]);

  useEffect(() => {
    void loadTopics().then(setTopics);
  }, []);

  function open(topic: Topic, line = 0) {
    return nav.push(topic.title, <DocViewer topic={topic} line={line} />);
  }

  useHints(searching
    ? [{ keys: "type", label: "search" }, { keys: "↑↓", label: "move" }, { keys: "enter", label: "open there" }, { keys: "esc", label: "topics" }]
    : [{ keys: "↑↓", label: "move" }, { keys: "enter", label: "read" }, { keys: "/", label: "search all guides" }, { keys: "esc", label: "back" }]);
  useKeys((input, key) => {
    if(key.escape) {
      if(searching) setSearching(false);
      else nav.pop();
    } else if(!searching && input === "/") setSearching(true);
  });

  if(!topics) return <Spinner label="Loading the guides" />;

  if(searching) {
    const items: ListItem[] = hits.map((hit, i) => ({ id: String(i), label: hit.text.replace(/^#+\s*/, "") || " ", mark: { text: hit.topic.name.padEnd(14).slice(0, 14), color: "cyan" } }));
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={accent}>/ </Text>
          <TextInput value={query} onChange={setQuery} placeholder="words to find in every guide" width={width - 4} />
        </Box>
        <Text dimColor>{query.trim() ? `${hits.length === 200 ? "200+" : hits.length} ${hits.length === 1 ? "line" : "lines"}` : " "}</Text>
        {items.length ? <List items={items} height={height - 3} vim={false} stickyKey={`docs:hits:${query}`} onSelect={item => { const hit = hits[Number(item.id)]!; open(hit.topic, hit.line); }} /> : null}
      </Box>
    );
  }

  const items: ListItem[] = topics.map(topic => ({ id: topic.name, label: topic.name }));
  const listWidth = Math.min(28, Math.max(18, ...topics.map(t => t.name.length + 4)));
  return (
    <Box flexDirection="row" flexGrow={1}>
      <Box width={listWidth} flexShrink={0} flexDirection="column">
        <List items={items} height={height - 1} stickyKey="docs:topics" onHighlight={item => setCurrent(topics.find(t => t.name === item?.id))} onSelect={item => open(topics.find(t => t.name === item.id)!)} />
      </Box>
      {current ? (
        <Box flexDirection="column" flexGrow={1} paddingLeft={2} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray">
          <Text bold color={accent}>{current.title}</Text>
          <Box marginTop={1}><Text wrap="wrap">{current.summary}</Text></Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>From the command line</Text>
            <Text color="cyan">vibe-cms docs {current.name}</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

export function DocViewer({ topic, line = 0 }: { topic: Topic, line?: number }) {
  const nav = useNav();
  const { width, height } = useSize();
  const lines = useMemo(() => markdownLines(topic.body), [topic]);
  useHints([{ keys: "↑↓ space b", label: "scroll" }, { keys: "g G", label: "top / end" }, { keys: "esc", label: "back" }]);
  useKeys((_, key) => {
    if(key.escape) nav.pop();
  });
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Title hint={`vibe-cms docs ${topic.name}`}>{topic.title}</Title>
      <Viewer lines={lines.slice(1)} width={Math.min(width, 100)} height={height - 2} start={Math.max(0, line - 1)} />
    </Box>
  );
}
