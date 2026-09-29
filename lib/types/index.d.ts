/** Conservative MCP schema discovery; authorization and conversation content stay with their owners. */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { Volatile } from '@deepseek-ai/cordis';
import { z as wire } from 'zod';
import type { EfficiencyState } from './types.ts';
export type * from './types.ts';
/** Loader plugin identity. */
export declare const name = "token-efficiency";
/** Services owning request presentation and durable session state. */
export declare const inject: string[];
/** Settings are sampled at each turn boundary. */
export interface Config {
    /** `off`, `measure`, `save`, or `efficient`. Sampled at the next turn boundary. */
    mode?: EfficiencyState['mode'] | Volatile<EfficiencyState['mode']>;
    /** Discovery page size, and the maximum newly matched tools in save mode, from 1 to 20. */
    pageSize?: number;
    /** Characters kept from each discovered description, from 40 to 1000. */
    descriptionChars?: number;
    /** Server names listed on discover_tools, from 1 to 40. Further servers stay searchable. */
    catalogServers?: number;
}
/** Validated plugin settings; mode updates do not unload the plugin. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    mode: z<"off" | "measure" | "efficient" | "save", "off" | "measure" | "efficient" | "save", "volatile-defined">;
    pageSize: z<number, number, "defined">;
    descriptionChars: z<number, number, "defined">;
    catalogServers: z<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    mode: z<"off" | "measure" | "efficient" | "save", "off" | "measure" | "efficient" | "save", "volatile-defined">;
    pageSize: z<number, number, "defined">;
    descriptionChars: z<number, number, "defined">;
    catalogServers: z<number, number, "defined">;
}>>, "plain">;
/** Empty measurement state before the first request.
 * @returns initial versioned projection state.
 */
export declare function initialState(): EfficiencyState;
/** Replay activation and measurements from versioned session facts. */
export declare const efficiencyProjection: {
    key: "tokenEfficiency";
    stateVersion: number;
    stateSchema: wire.ZodUnion<readonly [wire.ZodObject<{
        turn: wire.ZodNumber;
        activated: wire.ZodArray<wire.ZodString>;
        available: wire.ZodNumber;
        active: wire.ZodNumber;
        deferred: wire.ZodNumber;
        discoveryCalls: wire.ZodNumber;
        estimatedSchemaTokensAvoided: wire.ZodNumber;
        fallback: wire.ZodBoolean;
        version: wire.ZodLiteral<1>;
        mode: wire.ZodEnum<{
            off: "off";
            measure: "measure";
            efficient: "efficient";
        }>;
    }, wire.core.$strict>, wire.ZodObject<{
        turn: wire.ZodNumber;
        activated: wire.ZodArray<wire.ZodString>;
        available: wire.ZodNumber;
        active: wire.ZodNumber;
        deferred: wire.ZodNumber;
        discoveryCalls: wire.ZodNumber;
        estimatedSchemaTokensAvoided: wire.ZodNumber;
        fallback: wire.ZodBoolean;
        version: wire.ZodLiteral<2>;
        mode: wire.ZodEnum<{
            off: "off";
            measure: "measure";
            efficient: "efficient";
            save: "save";
        }>;
    }, wire.core.$strict>]>;
    init: typeof initialState;
    apply: (state: NoInfer<EfficiencyState>, event: import("@deepseek-ai/dsh-session").SessionEvent) => EfficiencyState;
    wire: {
        viewSchema: wire.ZodUnion<readonly [wire.ZodObject<{
            turn: wire.ZodNumber;
            activated: wire.ZodArray<wire.ZodString>;
            available: wire.ZodNumber;
            active: wire.ZodNumber;
            deferred: wire.ZodNumber;
            discoveryCalls: wire.ZodNumber;
            estimatedSchemaTokensAvoided: wire.ZodNumber;
            fallback: wire.ZodBoolean;
            version: wire.ZodLiteral<1>;
            mode: wire.ZodEnum<{
                off: "off";
                measure: "measure";
                efficient: "efficient";
            }>;
        }, wire.core.$strict>, wire.ZodObject<{
            turn: wire.ZodNumber;
            activated: wire.ZodArray<wire.ZodString>;
            available: wire.ZodNumber;
            active: wire.ZodNumber;
            deferred: wire.ZodNumber;
            discoveryCalls: wire.ZodNumber;
            estimatedSchemaTokensAvoided: wire.ZodNumber;
            fallback: wire.ZodBoolean;
            version: wire.ZodLiteral<2>;
            mode: wire.ZodEnum<{
                off: "off";
                measure: "measure";
                efficient: "efficient";
                save: "save";
            }>;
        }, wire.core.$strict>]>;
        view: (state: NoInfer<EfficiencyState>) => EfficiencyState;
    };
};
/** Install presentation filtering and discovery without altering execution restrictions.
 * @param ctx - plugin-owned Cordis context.
 * @param config - validated settings.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map