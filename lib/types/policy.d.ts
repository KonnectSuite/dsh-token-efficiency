/** Pure discovery ranking and schema selection, shared by runtime and evaluation. */
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
/** Identify a tool's MCP namespace.
 * @param name - registered tool name.
 * @returns server namespace, or undefined for built-in tools.
 */
export declare function serverOf(name: string): string | undefined;
/** Rank authorized tools deterministically; empty queries browse the complete catalog.
 * @param tools - already authorized schemas.
 * @param query - local lexical search text.
 * @param offset - zero-based result offset.
 * @param limit - maximum returned results.
 * @returns selected schemas in deterministic relevance order.
 */
export declare function searchTools(tools: readonly ToolSchema[], query: string, offset: number, limit: number): ToolSchema[];
/** Format a bounded, deterministic integration-server catalog.
 * @param names - server namespaces from the authorized catalog.
 * @param limit - maximum names to list.
 * @returns `none`, a comma-separated list, or that list plus a remainder count.
 */
export declare function serverCatalog(names: readonly string[], limit: number): string;
/** Preserve original tool schemas and ordering while withholding inactive MCP definitions.
 * @param tools - already authorized schemas.
 * @param activated - durable activated names.
 * @returns built-in and activated schemas.
 */
export declare function selectTools(tools: readonly ToolSchema[], activated: readonly string[]): ToolSchema[];
/** Approximate schema size using the shared meter; never provider billing.
 * @param tools - schemas to estimate.
 * @returns approximate schema tokens including framing.
 */
export declare function schemaTokens(tools: readonly ToolSchema[]): number;
/** Select a bounded set of MCP tools from user wording, without a model round-trip.
 * Descriptions are ignored. One distinctive name segment is enough. Ordinary segments such as
 * `project` or `status` count only when two segments of the same tool match.
 * @param tools - already authorized schemas.
 * @param query - user text available before the model request.
 * @param limit - maximum new matches.
 * @returns matching schemas, strongest name overlap first, at most `limit`.
 */
export declare function matchTools(tools: readonly ToolSchema[], query: string, limit: number): ToolSchema[];
//# sourceMappingURL=policy.d.ts.map