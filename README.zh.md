---
description: "测量 MCP 工具定义令牌。节省费用模式在请求前按用户措辞保留更小且稳定的工具列表，高效模式则推迟未使用的集成模式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-token-efficiency

[English](README.md) | 中文

## 概述

测量 MCP 工具定义增加了多少令牌。节省费用模式在请求前根据你的措辞保留更小且稳定的工具列表，没有额外的发现调用。高效模式可以推迟模式，但在 Flash/high 对比中估算费用更高。关闭和仅测量不改变请求。桌面端和 WebUI 在常规用量旁显示模式。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

共享基础配置已经以仅测量模式挂载这一行。希望使用更小且稳定的工具列表且不发起发现调用时，把 `mode` 改为 `save`；希望模型自行搜索时改为 `efficient`；希望停止测量时改为 `off`。模式变更在下一轮生效。`pageSize`、`descriptionChars` 和 `catalogServers` 会重新加载这一行。

### 何时选择

希望减少模式令牌且不增加模型请求时选择节省费用。名称与你的措辞没有重叠的工具保持不可用。希望模型自行搜索且可以接受该开销时选择高效模式。只想看到计数时选择仅测量。需要历史未过滤请求时保持关闭。PTC 和混合展示在任何模式下都只测量。

### 最小配置

```yaml
- id: token-efficiency
  name: '@deepseek-ai/dsh-token-efficiency'
  config:
    mode: measure
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `measure` | `off`、`measure`、`save` 或 `efficient`；下一轮采样 |
| `pageSize` | `5` | 发现页大小，也是节省费用模式新匹配工具的上限，范围 1 到 20 |
| `descriptionChars` | `180` | 每条发现描述保留的字符数，范围 40 到 1000 |
| `catalogServers` | `12` | `discover_tools` 列出的服务器名数量，范围 1 到 40 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-token-efficiency)完整列出了所有受支持的字段及其 JSDoc。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

提示组装采样可变模式，然后在高效原生模式下保留内置工具并去掉未启用的 `mcp__server__tool` 模式。节省费用模式改为根据本轮已领取的措辞选择有限工具，不加入发现工具，并保留先前选中的工具。`discover_tools` 在本地搜索已授权名称和描述，在会话剩余时间启用匹配项，并返回短文本；下一请求携带原始模式。启用状态是 `token-efficiency/state` 事件：载荷版本 1 保留原有模式，节省费用模式写入载荷版本 2。发现失败会在该轮剩余时间恢复已授权模式。空搜索提供浏览，不触发回退。权限检查仍由工具执行器负责。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [令牌计量](../token-meter/README.zh.md) — 提供方用量、上下文压力，以及此显示旁边的占用估算。
- [会话界面](../../client/ui-conversation/README.zh.md) — 渲染 `tokenEfficiency` 的共享上下文计量。
- [工具](../../core/tools/README.zh.md) — 授权、展示模式和执行批准。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-token-efficiency) — 每个受支持的配置字段。

-----

<a id="model-experience"></a>
## 模型体验

### 高效原生发现

#### 模型可见内容

在 `efficient` 原生模式下，请求保留内置工具、会话已启用的 MCP 工具和 `discover_tools`。`off`、`measure`、PTC 和混合展示发送已授权工具，而不包含该发现工具。下面的描述是稳定的；请求会追加 `Available integration servers: <names>.`，最多列出 `catalogServers` 个名称以及剩余数量。

##### 发现工具描述

```markdown
Find and enable integration tools for your task. Search by capability, server, or tool name. Use an empty query to browse; offset pages through results. Returned tools become callable on the next request. If no match, browse the catalog before concluding a capability is unavailable.
```

#### 令牌影响

只有高效原生模式会省略未启用的 MCP 定义。`discover_tools`、服务器后缀、发现请求和发现输出都会增加令牌。上下文计量显示最近一次组装的 `estimatedSchemaTokensAvoided`；该数字不是账单费用。

#### KV 缓存影响

`off` 和 `measure` 保持基线工具前缀。高效模式通过省略未启用的 MCP 模式替换该前缀。启用工具或改变已连接服务器时，可能从第一个变化的工具令牌起失去缓存复用。发现结果追加在可复用前缀之后。

### 节省费用的工具选择

#### 模型可见内容

在 `save` 原生模式下，请求保留内置工具，以及在请求前按工具名称选中的 MCP 工具。描述不参与匹配。一个有辨识度的名称片段即可；`project` 或 `status` 这类普通片段只有同时出现才计数。没有 `discover_tools`。未通过该名称测试的工具保持省略。`off`、`measure`、PTC 和混合展示仍然发送已授权工具。

#### 令牌影响

省略的 MCP 定义缩小工具前缀。节省费用模式不增加发现请求，也不增加发现输出。上下文计量显示最近一次组装的 `estimatedSchemaTokensAvoided`；该数字不是账单费用。

#### KV 缓存影响

工具列表在模型请求前确定，并在后续步骤保持稳定。之后的用户消息可以增加一个工具，并从第一个变化的工具令牌起失去缓存复用。断开服务器也可能改变前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明高效模式为何保持可选。节省费用模式同样保持可选。

- **费用门槛未通过** — Flash/high 隔离样例对比减少了输入令牌，并提高了估算费用，MCP 密集子集也是如此。
- **节省费用模式可能漏掉工具** — 单独一个普通名称词不够。Flash/max 的六项样例仍返回了所需事实，并且估算费用低于关闭模式。
- **词法搜索** — 不熟悉的措辞需要空查询和 `offset` 来浏览。
- **启用会累积** — 选中的工具在会话内保持启用，恢复和切换模型后仍然保留。
- **仅原生工具** — PTC 和混合展示记录测量结果，不隐藏模式。
- **不做其他压缩** — 历史、压缩、模型、推理强度和输出限制保持不变。
- **人工审查仍未完成** — 辅助评审分数不能授权默认启用。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。已交付行为以上文和包代码为准。

提示组装先于 `agent/pre-step`，因此两处都会采样模式。作用域限制对非原生展示隐藏发现工具；由于 SDK 文本已经渲染，限制变化会重新组装一次。`packages/llm/token-efficiency/tests/loader-composition.spec.ts` 中的 Loader 测试检查发现以及随后的原始模式。

144 次 Flash/high 隔离样例报告位于 `_scratch/token-efficiency-evaluation/report.json`。总体输入令牌从 490,107 变为 234,845，请求从 126 变为 172，估算费用从 0.04688 美元变为 0.05844 美元。缓存输入从 458,614 变为 168,064。按任务聚类的质量区间在 0–4 量表上约为 -0.08 到 +0.06。可用 `node packages/llm/token-efficiency/tests/report-evaluation.mjs` 重新计算。

名称匹配改为忽略描述之后，另一次 Flash/max 六项样例估算关闭模式为 0.0235 美元，节省费用模式为 0.0031 美元。所需事实都出现了。账户余额保持在 34.16 美元。历史任务的工具使用在两次运行之间有变化。

</details>
