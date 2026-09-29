---
description: "Measure MCP tool-definition tokens, keep a smaller stable tool list in save mode, or defer unused schemas in efficient mode."
kind: "package-reference"
---
<!-- MIRROR NOTICE - added by the mirror, not part of the package. -->

> ### This repository is a mirror, not a standalone build
>
> `@deepseek-ai/dsh-token-efficiency` is a plugin for **AryaAI**, a DeepSeek Harness fork. Its source
> depends on `@deepseek-ai/dsh-*` core packages at workspace version `0.1.7-rc.2`
> through `workspace:*`, and those versions are not published. The releases on npm
> are older (`0.0.1-rc.1`), so `pnpm install` and a build **will not work** in a
> fresh clone of this repository.
>
> To work on it, place this package into an AryaAI checkout at `packages/llm/token-efficiency`.
> This mirror exists so the source and its built output are versioned and reviewable
> in one place.
>
> The built output under `lib/` is committed for reference. It was produced inside
> the AryaAI workspace at `0.1.7-rc.2`.

---

# @deepseek-ai/dsh-token-efficiency

English | [中文](README.zh.md)

## Summary

Measure how many tokens MCP tool definitions add. Save mode keeps a smaller stable tool list chosen from your words before the request, with no extra discovery call. Efficient mode can defer schemas but spent more estimated cost in a Flash/high comparison. Off and measure leave the request unchanged. Desktop and WebUI show the mode beside ordinary usage.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shared base profile already mounts this row in measure mode. Change `mode` to `save` for a smaller stable tool list with no discovery call, to `efficient` when you want the model to search, or to `off` when you want measurement stopped. A mode change applies on the next turn. `pageSize`, `descriptionChars`, and `catalogServers` reload the row.

### When to choose it

Choose save when you want fewer schema tokens and no extra model request. A tool whose name does not overlap your words stays unavailable. Choose efficient when you want the model to search and you accept that overhead. Choose measure for counts only. Leave it off when you need the historical unfiltered request. PTC and mixed presentation stay measurement-only in every mode.

### Minimal configuration

```yaml
- id: token-efficiency
  name: '@deepseek-ai/dsh-token-efficiency'
  config:
    mode: measure
```

| Field | Default | Meaning |
|---|---|---|
| `mode` | `measure` | `off`, `measure`, `save`, or `efficient`; sampled on the next turn |
| `pageSize` | `5` | Discovery page size and the maximum newly matched tools in save mode, from 1 to 20 |
| `descriptionChars` | `180` | Characters kept from each discovered description, from 40 to 1000 |
| `catalogServers` | `12` | Server names listed on `discover_tools`, from 1 to 40 |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-token-efficiency) is the exhaustive source for every accepted field and its JSDoc.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Prompt assembly samples the volatile mode, then keeps built-in tools and drops inactive `mcp__server__tool` schemas in efficient native mode. Save mode instead selects a bounded set from words already claimed for the turn, adds no discovery tool, and keeps previously selected tools. `discover_tools` searches authorized names and descriptions locally, activates matches for the rest of the session, and returns short text; the next request carries the original schemas. Activation is the `token-efficiency/state` event: payload version 1 keeps the original modes, and save mode writes payload version 2. A discovery failure restores the authorized schemas for the rest of that turn. Empty search offers browsing and does not fall back. Permission checks stay on the tool executor.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Token meter](../token-meter/README.md) — provider usage, context pressure, and the occupancy estimate this display sits beside.
- [Conversation UI](../../client/ui-conversation/README.md) — the shared context meter that renders `tokenEfficiency`.
- [Tools](../../core/tools/README.md) — authorization, presentation mode, and execution approval.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-token-efficiency) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Efficient native discovery

#### What the model sees

In `efficient` native mode the request keeps built-in tools, session-activated MCP tools, and `discover_tools`. `off`, `measure`, PTC, and mixed presentation send the authorized tools without that discovery tool. The description below is stable; the request appends `Available integration servers: <names>.`, listing at most `catalogServers` names plus a remainder count.

##### Discovery tool description

```markdown
Find and enable integration tools for your task. Search by capability, server, or tool name. Use an empty query to browse; offset pages through results. Returned tools become callable on the next request. If no match, browse the catalog before concluding a capability is unavailable.
```

#### Token effect

Inactive MCP definitions are omitted only in efficient native mode. `discover_tools`, the server suffix, discovery requests, and discovery output add tokens. The context meter shows `estimatedSchemaTokensAvoided` for the latest assembly; that figure is not billed cost.

#### KV Cache effect

`off` and `measure` keep the baseline tool prefix. Efficient mode replaces that prefix by omitting inactive MCP schemas. Activating a tool, or changing the connected servers, can invalidate reuse from the first changed tool token. Discovery results append after the reusable prefix.

### Cost-saving tool selection

#### What the model sees

In `save` native mode the request keeps built-in tools and MCP tools selected from tool names before the request. Descriptions are ignored. One distinctive name segment is enough; ordinary segments such as `project` or `status` count only together. There is no `discover_tools`. A tool that does not meet that name test stays omitted. `off`, `measure`, PTC, and mixed presentation still send the authorized tools.

#### Token effect

Omitted MCP definitions shrink the tool prefix. Save mode adds no discovery request and no discovery output. The context meter shows `estimatedSchemaTokensAvoided` for the latest assembly; that figure is not billed cost.

#### KV Cache effect

The tool list is fixed before the model request and stays stable on later steps. A later user message can add a tool and invalidate reuse from the first changed tool token. Disconnecting a server can also change the prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits are why efficient mode stays opt-in. Save mode is also opt-in.

- **Cost gate failed** — the Flash/high fixture comparison reduced input tokens and increased estimated cost, including on the MCP-heavy subset.
- **Save mode can miss a tool** — one ordinary name word is not enough. A Flash/max six-task sample still returned the required facts and estimated less cost than Off.
- **Lexical search** — unfamiliar wording needs an empty query and `offset` to browse.
- **Activation accumulates** — selected tools stay for the session, including after resume and model switches.
- **Native tools only** — PTC and mixed presentation record measurements and do not hide schemas.
- **No other compression** — history, compaction, model, reasoning effort, and output limits stay unchanged.
- **Human review still open** — supplementary judge scores do not authorize default enablement.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative. Shipped behavior lives in the sections above and the package code.

Prompt assembly runs before `agent/pre-step`, so the mode is sampled in both places. A scoped restriction hides discovery from non-native presentation; a restriction change reassembles once because SDK text is already rendered. The Loader test in `packages/llm/token-efficiency/tests/loader-composition.spec.ts` checks discovery followed by the original schema.

The 144-run Flash/high fixture report is in `_scratch/token-efficiency-evaluation/report.json`. Overall input tokens moved from 490,107 to 234,845, requests from 126 to 172, and estimated cost from $0.04688 to $0.05844. Cached input moved from 458,614 to 168,064. The task-clustered quality interval was about -0.08 to +0.06 on the 0–4 scale. Recompute it with `node packages/llm/token-efficiency/tests/report-evaluation.mjs`.

A later Flash/max six-task sample, after name matching ignored descriptions, estimated $0.0235 for off and $0.0031 for save. All required facts were present. The account balance stayed at $34.16. History tool use varied between runs.

</details>
