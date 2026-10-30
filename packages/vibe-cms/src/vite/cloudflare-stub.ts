// What `cloudflare:*` imports resolve to in the editor build. Server code that
// imports them is stubbed out anyway; this only keeps the dependency scanner
// (which doesn't run plugins) from failing on them.
export class DurableObject {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export class RpcTarget {}
export const env = {};
export default {};
