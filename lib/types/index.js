import z from '@deepseek-ai/schemastery';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { z as wire } from 'zod';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { matchTools, schemaTokens, searchTools, selectTools, serverCatalog, serverOf } from "./policy.js";
/** Loader plugin identity. */
export const name = 'token-efficiency';
/** Services owning request presentation and durable session state. */
export const inject = ['tools', 'systemPrompt', 'agents', 'sessionProjections'];
/**
 * Discovery calls in one turn after which schema deferral stops paying. Each call is a
 * model round-trip that re-assembles the request, so the cost grows with every one while
 * the withheld-schema saving stays fixed. Evaluation measured deferral at break-even with
 * a recovery regression; this bounds the loss when a turn needs tools it cannot name.
 */
const DEFERRAL_RATCHET_CALLS = 3;
/** Validated plugin settings; mode updates do not unload the plugin. */
export const Config = z.object({
    mode: z.union(['off', 'measure', 'save', 'efficient']).default('measure').description('Off, measure, save cost, or efficient MCP tools. Changes apply next turn.').volatile(),
    pageSize: z.natural().min(1).max(20).default(5),
    descriptionChars: z.natural().min(40).max(1000).default(180),
    catalogServers: z.natural().min(1).max(40).default(12).description('Integration server names listed on discover_tools. Further servers stay searchable.'),
});
const measurementSchema = {
    turn: wire.number().int(), activated: wire.array(wire.string()),
    available: wire.number().int().nonnegative(), active: wire.number().int().nonnegative(),
    deferred: wire.number().int().nonnegative(), discoveryCalls: wire.number().int().nonnegative(),
    estimatedSchemaTokensAvoided: wire.number().int().nonnegative(), fallback: wire.boolean(),
};
const stateSchema = wire.union([
    wire.object({ version: wire.literal(1), mode: wire.enum(['off', 'measure', 'efficient']), ...measurementSchema }).strict(),
    wire.object({ version: wire.literal(2), mode: wire.enum(['off', 'measure', 'save', 'efficient']), ...measurementSchema }).strict(),
]);
/** Normalize a snapshot so save mode is payload version 2 and every older mode stays version 1.
 * @param draft - measurements plus the sampled mode.
 * @returns a payload existing readers can accept, except save mode.
 */
function stored(draft) {
    const fields = {
        turn: draft.turn, activated: draft.activated, available: draft.available, active: draft.active,
        deferred: draft.deferred, discoveryCalls: draft.discoveryCalls,
        estimatedSchemaTokensAvoided: draft.estimatedSchemaTokensAvoided, fallback: draft.fallback,
    };
    if (draft.mode === 'save')
        return { version: 2, mode: 'save', ...fields };
    return { version: 1, mode: draft.mode, ...fields };
}
/** Empty measurement state before the first request.
 * @returns initial versioned projection state.
 */
export function initialState() {
    return { version: 1, mode: 'measure', turn: -1, activated: [], available: 0, active: 0,
        deferred: 0, discoveryCalls: 0, estimatedSchemaTokensAvoided: 0, fallback: false };
}
/** Replay activation and measurements from versioned session facts. */
export const efficiencyProjection = {
    key: 'tokenEfficiency', stateVersion: 1, stateSchema, init: initialState,
    apply: (state, event) => event.type === 'token-efficiency/state' ? stateSchema.parse(event.data) : state,
    wire: { viewSchema: stateSchema, view: state => state },
};
/** Install presentation filtering and discovery without altering execution restrictions.
 * @param ctx - plugin-owned Cordis context.
 * @param config - validated settings.
 */
export function apply(ctx, config) {
    const currentMode = () => isVolatile(config.mode) ? config.mode.get() : config.mode ?? 'measure';
    const pageSize = config.pageSize ?? 5;
    const descriptionChars = config.descriptionChars ?? 180;
    const catalogServers = config.catalogServers ?? 12;
    if (!['off', 'measure', 'save', 'efficient'].includes(currentMode()) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20
        || !Number.isInteger(descriptionChars) || descriptionChars < 40 || descriptionChars > 1000
        || !Number.isInteger(catalogServers) || catalogServers < 1 || catalogServers > 40)
        throw new Error('Invalid token-efficiency configuration');
    ctx.sessionProjections.register(efficiencyProjection);
    const catalogs = new WeakMap();
    const pendingText = new WeakMap();
    const discoveryRestrictions = new WeakMap();
    /** Discovery calls observed in the current turn, for the deferral-cost ratchet. */
    const discoveryThisTurn = new WeakMap();
    const restrictionDisposers = new Set();
    ctx.effect(() => () => { for (const dispose of restrictionDisposers)
        dispose(); });
    const read = (agent) => {
        const state = ctx.sessionProjections.stateOf(agent.session, 'tokenEfficiency');
        if (state === undefined)
            throw new Error('Token efficiency projection unavailable');
        return state;
    };
    const save = (agent, state) => {
        agent.session.append('token-efficiency/state', stored(state));
    };
    ctx.on('agent/inbox/claimed', ({ agent, message }) => {
        const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
        if (text.length === 0)
            return;
        const pending = pendingText.get(agent) ?? new Map();
        pending.set(message.id, text);
        pendingText.set(agent, pending);
    });
    ctx.on('agent/pre-step', async ({ agent, turn }, next) => {
        const state = read(agent);
        if (state.turn !== turn) {
            discoveryThisTurn.set(agent, { turn, calls: 0 });
            save(agent, { ...state, mode: currentMode(), turn, fallback: false });
        }
        return next();
    });
    ctx.tools.register(defineTool({
        name: 'discover_tools',
        description: 'Find and enable integration tools for your task. Search by capability, server, or tool name. Use an empty query to browse; offset pages through results. Returned tools become callable on the next request. If no match, browse the catalog before concluding a capability is unavailable.',
        parameters: {
            query: { type: 'string', required: true, description: 'Capability or tool name; empty string browses all tools.' },
            offset: { type: 'integer', description: 'Zero-based result offset, default 0.' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute(args, exec) {
            if (exec.agent === undefined)
                throw new Error('Discovery requires an agent session');
            const agent = exec.agent;
            const state = read(agent);
            const offset = args.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0)
                throw new Error('offset must be a nonnegative integer');
            const counter = discoveryThisTurn.get(agent);
            if (counter === undefined || counter.turn !== state.turn)
                discoveryThisTurn.set(agent, { turn: state.turn, calls: 1 });
            else
                counter.calls += 1;
            try {
                const catalog = catalogs.get(agent);
                if (catalog === undefined)
                    throw new Error('No assembled tool catalog available');
                const authorized = catalog.filter(tool => ctx.tools.get(tool.name, agent) !== undefined);
                const matches = searchTools(authorized, args.query, offset, pageSize + 1);
                const selected = matches.slice(0, pageSize);
                save(agent, { ...state, activated: [...new Set([...state.activated, ...selected.map(tool => tool.name)])].sort(),
                    discoveryCalls: state.discoveryCalls + 1 });
                // Longer absence wording measured worse: a model proving a capability absent
                // exhausts the catalog whatever the hint says, and the extra text is billed on
                // every discovery result. Keep the original short hint; `absent` stays as
                // telemetry for readers that want it.
                return Promise.resolve(JSON.stringify({
                    tools: selected.map(tool => ({ name: tool.name, description: tool.description.slice(0, descriptionChars) })),
                    nextOffset: matches.length > pageSize ? offset + pageSize : null,
                    absent: selected.length === 0 && args.query.trim() !== '' && offset === 0,
                    hint: selected.length === 0 ? 'Try a broader query or query="" to browse all integrations.' : 'These tools are available on your next request.'
                }));
            }
            catch (error) {
                save(agent, { ...state, fallback: true, discoveryCalls: state.discoveryCalls + 1 });
                ctx.logger.warn('Token discovery failed; restoring authorized schemas: %s', error instanceof Error ? error.message : String(error));
                return Promise.resolve('Tool discovery failed. All authorized integration tools will be available on the next request.');
            }
        },
        presentCall: args => ({ card: 'generic', title: 'Discover integration tools', kind: 'read', rawInput: args.query }),
    }));
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const agent = context.agent;
        if (agent === undefined) {
            const assembly = await next();
            assembly.tools = assembly.tools.filter(tool => tool.name !== 'discover_tools');
            return assembly;
        }
        let state = read(agent);
        const turn = ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn;
        if (turn !== undefined && state.turn !== turn) {
            state = stored({ ...state, mode: currentMode(), turn, fallback: false });
            save(agent, state);
            discoveryThisTurn.set(agent, { turn, calls: 0 });
        }
        const native = ctx.tools.get('run_code', agent) === undefined;
        const enabled = state.mode === 'efficient' && native && !state.fallback;
        const saving = state.mode === 'save' && native && !state.fallback;
        // Deferring schemas buys a fixed saving and pays a per-round-trip cost. Past a few
        // discovery calls in one turn the model plainly needs the tools in front of it, and
        // continuing to withhold them costs more than it saves. Deferral stops for that turn
        // instead of for the session, so one heavy turn does not forfeit the saving entirely.
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
        }
        else if (restricting && !restriction) {
            const dispose = agent.ctx.tools.restrict({ deny: ['discover_tools'] });
            discoveryRestrictions.set(agent, dispose);
            restrictionDisposers.add(dispose);
            agent.ctx.effect(() => () => { restrictionDisposers.delete(dispose); });
            return ctx.systemPrompt.assemble(context);
        }
        const assembly = await next();
        const original = assembly.tools.filter(tool => tool.name !== 'discover_tools');
        catalogs.set(agent, original.filter(tool => serverOf(tool.name) !== undefined));
        const discovery = assembly.tools.find(tool => tool.name === 'discover_tools');
        const pending = pendingText.get(agent);
        const claimed = pending === undefined ? '' : [...pending.values()].join('\n');
        // This assembly consumes the claimed text. Retaining it made every later turn
        // match against the whole session history, so a tool named once stayed activated
        // and the map grew without bound.
        pending?.clear();
        const matched = savingNow ? matchTools(original, claimed, pageSize).map(tool => tool.name) : [];
        const activated = savingNow ? [...new Set([...state.activated, ...matched])].sort() : state.activated;
        const selected = enabledNow && discovery !== undefined ? selectTools(original, state.activated)
            : savingNow ? selectTools(original, activated) : original;
        assembly.tools = enabledNow && discovery !== undefined ? [...selected, discovery] : savingNow ? selected : original;
        if (enabledNow && discovery !== undefined) {
            const servers = original.map(tool => serverOf(tool.name)).filter(server => server !== undefined);
            // A tool description is logged in request/header and works even with complete system prompts.
            assembly.tools[assembly.tools.length - 1] = { ...discovery, description: `${discovery.description} Available integration servers: ${serverCatalog(servers, catalogServers)}.` };
        }
        const available = (native ? original : ctx.tools.schemas(agent)).filter(tool => serverOf(tool.name) !== undefined).length;
        const active = native ? selected.filter(tool => serverOf(tool.name) !== undefined).length : available;
        const measurement = { ...state, activated, available, active, deferred: available - active,
            estimatedSchemaTokensAvoided: Math.max(0, schemaTokens(original) - schemaTokens(assembly.tools)) };
        // Measure mode changes nothing a reader can act on: it neither filters tools nor
        // activates them, so its counters are derived, not new facts. Appending them on
        // every assembly rewrote the session log and the prompt cache for no reason.
        const recordable = state.mode !== 'measure'
            || state.turn !== measurement.turn
            || state.fallback !== measurement.fallback
            || state.activated.join('\u0000') !== measurement.activated.join('\u0000');
        if (recordable)
            save(agent, measurement);
        return assembly;
    });
}
//# sourceMappingURL=index.js.map