// The query API without the client: one POST with a list of serialized queries. Works from any language.
const url = process.env.SITE_URL ?? "http://localhost:1340";

const response = await fetch(`${url}/_vibe/api/query`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    queries: [
      { type: "post", op: "findMany", args: { orderBy: [{ path: ["title"], dir: "asc" }], limit: 10 } },
      { type: "post", op: "findFirst", args: { where: { op: "eq", path: ["slug"], value: "hello" } } },
      { type: "post", op: "count", args: {} }
    ]
  })
});

// `{ results: [...] }`, one per query in order; failures are `{ error, tag, details? }` with a 4xx status.
console.log(JSON.stringify(await response.json(), null, 2));
