/** Pure discovery ranking and schema selection, shared by runtime and evaluation. */
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { estimateToolsTokens } from '@deepseek-ai/dsh-token-meter/estimate'

/** Identify a tool's MCP namespace.
 * @param name - registered tool name.
 * @returns server namespace, or undefined for built-in tools.
 */
export function serverOf(name: string): string | undefined {
  return /^mcp__([^]+?)__/.exec(name)?.[1]
}

/** Rank authorized tools deterministically; empty queries browse the complete catalog.
 * @param tools - already authorized schemas.
 * @param query - local lexical search text.
 * @param offset - zero-based result offset.
 * @param limit - maximum returned results.
 * @returns selected schemas in deterministic relevance order.
 */
export function searchTools(tools: readonly ToolSchema[], query: string, offset: number, limit: number): ToolSchema[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return tools.filter(tool => serverOf(tool.name) !== undefined)
    .map(tool => ({ tool, score: terms.reduce((score, term) => score
      + (tool.name.toLowerCase().includes(term) ? 3 : 0)
      + (tool.description.toLowerCase().includes(term) ? 1 : 0), 0) }))
    .filter(entry => terms.length === 0 || entry.score > 0)
    .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
    .slice(offset, offset + limit).map(entry => entry.tool)
}

/** Format a bounded, deterministic integration-server catalog.
 * @param names - server namespaces from the authorized catalog.
 * @param limit - maximum names to list.
 * @returns `none`, a comma-separated list, or that list plus a remainder count.
 */
export function serverCatalog(names: readonly string[], limit: number): string {
  const unique = [...new Set(names)].sort()
  const listed = unique.slice(0, limit)
  const extra = unique.length - listed.length
  if (listed.length === 0) return 'none'
  if (extra === 0) return listed.join(', ')
  return `${listed.join(', ')}, and ${extra} more`
}

/** Preserve original tool schemas and ordering while withholding inactive MCP definitions.
 * @param tools - already authorized schemas.
 * @param activated - durable activated names.
 * @returns built-in and activated schemas.
 */
export function selectTools(tools: readonly ToolSchema[], activated: readonly string[]): ToolSchema[] {
  const names = new Set(activated)
  return tools.filter(tool => serverOf(tool.name) === undefined || names.has(tool.name))
}

/** Approximate schema size using the shared meter; never provider billing.
 * @param tools - schemas to estimate.
 * @returns approximate schema tokens including framing.
 */
export function schemaTokens(tools: readonly ToolSchema[]): number {
  return estimateToolsTokens({ tools: [...tools] })
}

/** Generic words that would otherwise match almost every tool description. */
const MATCH_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'your', 'you', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'can', 'will', 'just', 'into', 'onto', 'about', 'read',
  'fixture', 'report', 'include', 'please', 'using', 'use', 'need', 'want', 'make', 'get',
  'set', 'all', 'any', 'our', 'its', 'via', 'per', 'text', 'data', 'how',
  'what', 'when', 'where', 'which', 'who', 'why', 'does', 'did', 'than', 'then', 'them',
  'they', 'their', 'also', 'only', 'tool', 'tools',
])

/** Name segments that are ordinary words. One of them is not a save-mode match. */
const GENERIC_NAME_SEGMENTS = new Set([
  'project', 'status', 'list', 'read', 'search', 'info', 'file', 'files', 'name', 'type',
  'query', 'page', 'item', 'items', 'result', 'results',
])

/** Select a bounded set of MCP tools from user wording, without a model round-trip.
 * Descriptions are ignored. One distinctive name segment is enough. Ordinary segments such as
 * `project` or `status` count only when two segments of the same tool match.
 * @param tools - already authorized schemas.
 * @param query - user text available before the model request.
 * @param limit - maximum new matches.
 * @returns matching schemas, strongest name overlap first, at most `limit`.
 */
export function matchTools(tools: readonly ToolSchema[], query: string, limit: number): ToolSchema[] {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length >= 3 && !MATCH_STOPWORDS.has(term)))]
  if (terms.length === 0 || limit < 1) return []
  return tools.filter(tool => serverOf(tool.name) !== undefined)
    .map((tool) => {
      const segments = tool.name.toLowerCase().split(/[^a-z0-9]+/).filter(segment => segment.length >= 3)
      const matched = segments.filter(segment => terms.some(term => segment.includes(term) || term.includes(segment)))
      const distinctive = matched.filter(segment => !GENERIC_NAME_SEGMENTS.has(segment)).length
      return { tool, distinctive, total: matched.length }
    })
    .filter(entry => entry.distinctive >= 1 || entry.total >= 2)
    .sort((a, b) => b.distinctive - a.distinctive || b.total - a.total
      || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
    .slice(0, limit).map(entry => entry.tool)
}
