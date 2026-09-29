/** Measurements shared by every token-efficiency payload version. */
interface EfficiencyMeasurement {
    /** Turn number this snapshot belongs to, or -1 before the first turn. */
    turn: number;
    /** MCP tool names activated for the rest of the session. */
    activated: string[];
    /** Authorized MCP tools in the latest assembly. */
    available: number;
    /** MCP tools included in the latest model-visible assembly. */
    active: number;
    /** Authorized MCP tools omitted from the latest assembly. */
    deferred: number;
    /** Discovery attempts recorded for this session. */
    discoveryCalls: number;
    /** Schema tokens omitted from the latest assembly. This is not billed cost. */
    estimatedSchemaTokensAvoided: number;
    /** Whether discovery failed and authorized schemas were restored for this turn. */
    fallback: boolean;
}
/** Payload version 1. Its mode set stays fixed so existing logs remain readable. */
export interface EfficiencyStateV1 extends EfficiencyMeasurement {
    /** Durable snapshot version. Readers of this payload require version 1. */
    version: 1;
    /** Effective mode sampled for this turn. */
    mode: 'off' | 'measure' | 'efficient';
}
/** Payload version 2. It adds save mode and leaves version 1 unchanged. */
export interface EfficiencyStateV2 extends EfficiencyMeasurement {
    /** Durable snapshot version. Readers of this payload require version 2. */
    version: 2;
    /** Effective mode sampled for this turn. */
    mode: 'off' | 'measure' | 'save' | 'efficient';
}
/** Durable token-efficiency measurements and activation state. */
export type EfficiencyState = EfficiencyStateV1 | EfficiencyStateV2;
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        /** Versioned policy and activation snapshot; model-visible schemas remain in request/header. */
        'token-efficiency/state': EfficiencyState;
    }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionStateMap {
        tokenEfficiency: EfficiencyState;
    }
    interface SessionProjectionMap {
        tokenEfficiency: EfficiencyState;
    }
}
export {};
//# sourceMappingURL=types.d.ts.map