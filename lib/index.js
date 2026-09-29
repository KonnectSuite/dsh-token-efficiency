import z from "@deepseek-ai/schemastery";
import { isVolatile } from "@deepseek-ai/cosmokit";
import { z as z$1 } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { estimateToolsTokens } from "@deepseek-ai/dsh-token-meter/estimate";
//#region lib/types/policy.js
/** Identify a tool's MCP namespace.
* @param name - registered tool name.
* @returns server namespace, or undefined for built-in tools.
*/
function serverOf(name) {
	return /^mcp__([^]+?)__/.exec(name)?.[1];
}
/** Rank authorized tools deterministically; empty queries browse the complete catalog.
* @param tools - already authorized schemas.
* @param query - local lexical search text.
* @param offset - zero-based result offset.
* @param limit - maximum returned results.
* @returns selected schemas in deterministic relevance order.
*/
function searchTools(tools, query, offset, limit) {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	return tools.filter((tool) => serverOf(tool.name) !== void 0).map((tool) => ({
		tool,
		score: terms.reduce((score, term) => score + (tool.name.toLowerCase().includes(term) ? 3 : 0) + (tool.description.toLowerCase().includes(term) ? 1 : 0), 0)
	})).filter((entry) => terms.length === 0 || entry.score > 0).sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0)).slice(offset, offset + limit).map((entry) => entry.tool);
}
/** Format a bounded, deterministic integration-server catalog.
* @param names - server namespaces from the authorized catalog.
* @param limit - maximum names to list.
* @returns `none`, a comma-separated list, or that list plus a remainder count.
*/
function serverCatalog(names, limit) {
	const unique = [...new Set(names)].sort();
	const listed = unique.slice(0, limit);
	const extra = unique.length - listed.length;
	if (listed.length === 0) return "none";
	if (extra === 0) return listed.join(", ");
	return `${listed.join(", ")}, and ${extra} more`;
}
/** Preserve original tool schemas and ordering while withholding inactive MCP definitions.
* @param tools - already authorized schemas.
* @param activated - durable activated names.
* @returns built-in and activated schemas.
*/
function selectTools(tools, activated) {
	const names = new Set(activated);
	return tools.filter((tool) => serverOf(tool.name) === void 0 || names.has(tool.name));
}
/** Approximate schema size using the shared meter; never provider billing.
* @param tools - schemas to estimate.
* @returns approximate schema tokens including framing.
*/
function schemaTokens(tools) {
	return estimateToolsTokens({ tools: [...tools] });
}
/** Generic words that would otherwise match almost every tool description. */
const MATCH_STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"from",
	"that",
	"this",
	"your",
	"you",
	"are",
	"was",
	"were",
	"have",
	"has",
	"had",
	"not",
	"but",
	"can",
	"will",
	"just",
	"into",
	"onto",
	"about",
	"read",
	"fixture",
	"report",
	"include",
	"please",
	"using",
	"use",
	"need",
	"want",
	"make",
	"get",
	"set",
	"all",
	"any",
	"our",
	"its",
	"via",
	"per",
	"text",
	"data",
	"how",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"does",
	"did",
	"than",
	"then",
	"them",
	"they",
	"their",
	"also",
	"only",
	"tool",
	"tools"
]);
/** Name segments that are ordinary words. One of them is not a save-mode match. */
const GENERIC_NAME_SEGMENTS = new Set([
	"project",
	"status",
	"list",
	"read",
	"search",
	"info",
	"file",
	"files",
	"name",
	"type",
	"query",
	"page",
	"item",
	"items",
	"result",
	"results"
]);
/** Select a bounded set of MCP tools from user wording, without a model round-trip.
* Descriptions are ignored. One distinctive name segment is enough. Ordinary segments such as
* `project` or `status` count only when two segments of the same tool match.
* @param tools - already authorized schemas.
* @param query - user text available before the model request.
* @param limit - maximum new matches.
* @returns matching schemas, strongest name overlap first, at most `limit`.
*/
function matchTools(tools, query, limit) {
	const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3 && !MATCH_STOPWORDS.has(term)))];
	if (terms.length === 0 || limit < 1) return [];
	return tools.filter((tool) => serverOf(tool.name) !== void 0).map((tool) => {
		const matched = tool.name.toLowerCase().split(/[^a-z0-9]+/).filter((segment) => segment.length >= 3).filter((segment) => terms.some((term) => segment.includes(term) || term.includes(segment)));
		return {
			tool,
			distinctive: matched.filter((segment) => !GENERIC_NAME_SEGMENTS.has(segment)).length,
			total: matched.length
		};
	}).filter((entry) => entry.distinctive >= 1 || entry.total >= 2).sort((a, b) => b.distinctive - a.distinctive || b.total - a.total || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0)).slice(0, limit).map((entry) => entry.tool);
}
//#endregion
//#region lib/types/index.js
/** Loader plugin identity. */
const name = "token-efficiency";
/** Services owning request presentation and durable session state. */
const inject = [
	"tools",
	"systemPrompt",
	"agents",
	"sessionProjections"
];
/**
* Discovery calls in one turn after which schema deferral stops paying. Each call is a
* model round-trip that re-assembles the request, so the cost grows with every one while
* the withheld-schema saving stays fixed. Evaluation measured deferral at break-even with
* a recovery regression; this bounds the loss when a turn needs tools it cannot name.
*/
const DEFERRAL_RATCHET_CALLS = 3;
/** Validated plugin settings; mode updates do not unload the plugin. */
const Config = z.object({
	mode: z.union([
		"off",
		"measure",
		"save",
		"efficient"
	]).default("measure").description("Off, measure, save cost, or efficient MCP tools. Changes apply next turn.").volatile(),
	pageSize: z.natural().min(1).max(20).default(5),
	descriptionChars: z.natural().min(40).max(1e3).default(180),
	catalogServers: z.natural().min(1).max(40).default(12).description("Integration server names listed on discover_tools. Further servers stay searchable.")
});
const measurementSchema = {
	turn: z$1.number().int(),
	activated: z$1.array(z$1.string()),
	available: z$1.number().int().nonnegative(),
	active: z$1.number().int().nonnegative(),
	deferred: z$1.number().int().nonnegative(),
	discoveryCalls: z$1.number().int().nonnegative(),
	estimatedSchemaTokensAvoided: z$1.number().int().nonnegative(),
	fallback: z$1.boolean()
};
const stateSchema = z$1.union([z$1.object({
	version: z$1.literal(1),
	mode: z$1.enum([
		"off",
		"measure",
		"efficient"
	]),
	...measurementSchema
}).strict(), z$1.object({
	version: z$1.literal(2),
	mode: z$1.enum([
		"off",
		"measure",
		"save",
		"efficient"
	]),
	...measurementSchema
}).strict()]);
/** Normalize a snapshot so save mode is payload version 2 and every older mode stays version 1.
* @param draft - measurements plus the sampled mode.
* @returns a payload existing readers can accept, except save mode.
*/
function stored(draft) {
	const fields = {
		turn: draft.turn,
		activated: draft.activated,
		available: draft.available,
		active: draft.active,
		deferred: draft.deferred,
		discoveryCalls: draft.discoveryCalls,
		estimatedSchemaTokensAvoided: draft.estimatedSchemaTokensAvoided,
		fallback: draft.fallback
	};
	if (draft.mode === "save") return {
		version: 2,
		mode: "save",
		...fields
	};
	return {
		version: 1,
		mode: draft.mode,
		...fields
	};
}
/** Empty measurement state before the first request.
* @returns initial versioned projection state.
*/
function initialState() {
	return {
		version: 1,
		mode: "measure",
		turn: -1,
		activated: [],
		available: 0,
		active: 0,
		deferred: 0,
		discoveryCalls: 0,
		estimatedSchemaTokensAvoided: 0,
		fallback: false
	};
}
/** Replay activation and measurements from versioned session facts. */
const efficiencyProjection = {
	key: "tokenEfficiency",
	stateVersion: 1,
	stateSchema,
	init: initialState,
	apply: (state, event) => event.type === "token-efficiency/state" ? stateSchema.parse(event.data) : state,
	wire: {
		viewSchema: stateSchema,
		view: (state) => state
	}
};
/** Install presentation filtering and discovery without altering execution restrictions.
* @param ctx - plugin-owned Cordis context.
* @param config - validated settings.
*/
function apply(ctx, config) {
	const currentMode = () => isVolatile(config.mode) ? config.mode.get() : config.mode ?? "measure";
	const pageSize = config.pageSize ?? 5;
	const descriptionChars = config.descriptionChars ?? 180;
	const catalogServers = config.catalogServers ?? 12;
	if (![
		"off",
		"measure",
		"save",
		"efficient"
	].includes(currentMode()) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20 || !Number.isInteger(descriptionChars) || descriptionChars < 40 || descriptionChars > 1e3 || !Number.isInteger(catalogServers) || catalogServers < 1 || catalogServers > 40) throw new Error("Invalid token-efficiency configuration");
	ctx.sessionProjections.register(efficiencyProjection);
	const catalogs = /* @__PURE__ */ new WeakMap();
	const pendingText = /* @__PURE__ */ new WeakMap();
	const discoveryRestrictions = /* @__PURE__ */ new WeakMap();
	/** Discovery calls observed in the current turn, for the deferral-cost ratchet. */
	const discoveryThisTurn = /* @__PURE__ */ new WeakMap();
	const restrictionDisposers = /* @__PURE__ */ new Set();
	ctx.effect(() => () => {
		for (const dispose of restrictionDisposers) dispose();
	});
	const read = (agent) => {
		const state = ctx.sessionProjections.stateOf(agent.session, "tokenEfficiency");
		if (state === void 0) throw new Error("Token efficiency projection unavailable");
		return state;
	};
	const save = (agent, state) => {
		agent.session.append("token-efficiency/state", stored(state));
	};
	ctx.on("agent/inbox/claimed", ({ agent, message }) => {
		const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
		if (text.length === 0) return;
		const pending = pendingText.get(agent) ?? /* @__PURE__ */ new Map();
		pending.set(message.id, text);
		pendingText.set(agent, pending);
	});
	ctx.on("agent/pre-step", async ({ agent, turn }, next) => {
		const state = read(agent);
		if (state.turn !== turn) {
			discoveryThisTurn.set(agent, {
				turn,
				calls: 0
			});
			save(agent, {
				...state,
				mode: currentMode(),
				turn,
				fallback: false
			});
		}
		return next();
	});
	ctx.tools.register(defineTool({
		name: "discover_tools",
		description: "Find and enable integration tools for your task. Search by capability, server, or tool name. Use an empty query to browse; offset pages through results. Returned tools become callable on the next request. If no match, browse the catalog before concluding a capability is unavailable.",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "Capability or tool name; empty string browses all tools."
			},
			offset: {
				type: "integer",
				description: "Zero-based result offset, default 0."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute(args, exec) {
			if (exec.agent === void 0) throw new Error("Discovery requires an agent session");
			const agent = exec.agent;
			const state = read(agent);
			const offset = args.offset ?? 0;
			if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
			const counter = discoveryThisTurn.get(agent);
			if (counter === void 0 || counter.turn !== state.turn) discoveryThisTurn.set(agent, {
				turn: state.turn,
				calls: 1
			});
			else counter.calls += 1;
			try {
				const catalog = catalogs.get(agent);
				if (catalog === void 0) throw new Error("No assembled tool catalog available");
				const matches = searchTools(catalog.filter((tool) => ctx.tools.get(tool.name, agent) !== void 0), args.query, offset, pageSize + 1);
				const selected = matches.slice(0, pageSize);
				save(agent, {
					...state,
					activated: [...new Set([...state.activated, ...selected.map((tool) => tool.name)])].sort(),
					discoveryCalls: state.discoveryCalls + 1
				});
				return Promise.resolve(JSON.stringify({
					tools: selected.map((tool) => ({
						name: tool.name,
						description: tool.description.slice(0, descriptionChars)
					})),
					nextOffset: matches.length > pageSize ? offset + pageSize : null,
					absent: selected.length === 0 && args.query.trim() !== "" && offset === 0,
					hint: selected.length === 0 ? "Try a broader query or query=\"\" to browse all integrations." : "These tools are available on your next request."
				}));
			} catch (error) {
				save(agent, {
					...state,
					fallback: true,
					discoveryCalls: state.discoveryCalls + 1
				});
				ctx.logger.warn("Token discovery failed; restoring authorized schemas: %s", error instanceof Error ? error.message : String(error));
				return Promise.resolve("Tool discovery failed. All authorized integration tools will be available on the next request.");
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Discover integration tools",
			kind: "read",
			rawInput: args.query
		})
	}));
	ctx.on("system-prompt/assemble", async (_assembly, context, next) => {
		const agent = context.agent;
		if (agent === void 0) {
			const assembly = await next();
			assembly.tools = assembly.tools.filter((tool) => tool.name !== "discover_tools");
			return assembly;
		}
		let state = read(agent);
		const turn = ctx.sessionProjections.stateOf(agent.session, "turnBoundary")?.lastTurn;
		if (turn !== void 0 && state.turn !== turn) {
			state = stored({
				...state,
				mode: currentMode(),
				turn,
				fallback: false
			});
			save(agent, state);
			discoveryThisTurn.set(agent, {
				turn,
				calls: 0
			});
		}
		const native = ctx.tools.get("run_code", agent) === void 0;
		const enabled = state.mode === "efficient" && native && !state.fallback;
		const saving = state.mode === "save" && native && !state.fallback;
		const ratcheted = enabled && (discoveryThisTurn.get(agent)?.calls ?? 0) >= DEFERRAL_RATCHET_CALLS;
		const enabledNow = enabled && !ratcheted;
		const savingNow = saving && !ratcheted;
		const restricting = !enabledNow && !state.fallback;
		const restriction = discoveryRestrictions.get(agent);
		if (!restricting && restriction) {
			restriction();
			restrictionDisposers.delete(restriction);
			discoveryRestrictions.delete(agent);
			return ctx.systemPrompt.assemble(context);
		} else if (restricting && !restriction) {
			const dispose = agent.ctx.tools.restrict({ deny: ["discover_tools"] });
			discoveryRestrictions.set(agent, dispose);
			restrictionDisposers.add(dispose);
			agent.ctx.effect(() => () => {
				restrictionDisposers.delete(dispose);
			});
			return ctx.systemPrompt.assemble(context);
		}
		const assembly = await next();
		const original = assembly.tools.filter((tool) => tool.name !== "discover_tools");
		catalogs.set(agent, original.filter((tool) => serverOf(tool.name) !== void 0));
		const discovery = assembly.tools.find((tool) => tool.name === "discover_tools");
		const pending = pendingText.get(agent);
		const claimed = pending === void 0 ? "" : [...pending.values()].join("\n");
		pending?.clear();
		const matched = savingNow ? matchTools(original, claimed, pageSize).map((tool) => tool.name) : [];
		const activated = savingNow ? [...new Set([...state.activated, ...matched])].sort() : state.activated;
		const selected = enabledNow && discovery !== void 0 ? selectTools(original, state.activated) : savingNow ? selectTools(original, activated) : original;
		assembly.tools = enabledNow && discovery !== void 0 ? [...selected, discovery] : savingNow ? selected : original;
		if (enabledNow && discovery !== void 0) {
			const servers = original.map((tool) => serverOf(tool.name)).filter((server) => server !== void 0);
			assembly.tools[assembly.tools.length - 1] = {
				...discovery,
				description: `${discovery.description} Available integration servers: ${serverCatalog(servers, catalogServers)}.`
			};
		}
		const available = (native ? original : ctx.tools.schemas(agent)).filter((tool) => serverOf(tool.name) !== void 0).length;
		const active = native ? selected.filter((tool) => serverOf(tool.name) !== void 0).length : available;
		const measurement = {
			...state,
			activated,
			available,
			active,
			deferred: available - active,
			estimatedSchemaTokensAvoided: Math.max(0, schemaTokens(original) - schemaTokens(assembly.tools))
		};
		if (state.mode !== "measure" || state.turn !== measurement.turn || state.fallback !== measurement.fallback || state.activated.join("\0") !== measurement.activated.join("\0")) save(agent, measurement);
		return assembly;
	});
}
//#endregion
export { Config, apply, efficiencyProjection, initialState, inject, name };
