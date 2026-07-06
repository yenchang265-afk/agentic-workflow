/**
 * The host substrate every core module runs against. Each plugin provides its
 * own implementation once and threads it through:
 *
 * - The OpenCode plugin passes Bun's `$` and the opencode SDK client, which
 *   satisfy these interfaces structurally.
 * - The Claude Code MCP server passes the node shims in
 *   `claude-plugin/mcp-server/src/shim.ts` (child_process + fs).
 *
 * Nothing in core may import a host SDK (`@opencode-ai/plugin`,
 * `@modelcontextprotocol/sdk`) — this module is the entire host surface.
 */
export {};
