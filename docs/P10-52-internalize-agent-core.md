# P10-52 评估：是否进一步**内化** `agent-core`（对标 OpenClaw 做法）

> 任务性质：**评估 + 立项**，不是实现。结论先行。
> 关联执行项：`DEV_SPEC.md` 阶段 10 `P10-52`。
> 核对依据：本地 `node_modules/@earendil-works/pi-*` 实测（2026-09-05）、`DEV_SPEC.md` §2.5 决策链、OpenClaw（`~/Desktop/project/openclaw`，四包钉 `0.75.5`）源码核对。

## 结论

**不立即内化。将「内化 `agent-core`」单独立项为长期 backlog 选项，保留当前「registry 钉版本黑盒」方案。**

- 当前方案（P7-28/29 确立）：`package.json` 钉 `@earendil-works/pi-{agent-core,ai,coding-agent,tui}@0.80.3`（精确版本、不带 `^`），**黑盒 dist，零行为变化**，风险最低；
- 「内化」= 把 `pi-agent-core`（及大概率连带 `pi-ai` / `pi-coding-agent`）**源码 vendor 进本仓**，自建宿主直接驱动 in-repo 循环内核，而非依赖发布包。
- 这一路径**会翻转 P7 的核心决策**（「版本策略：钉 0.80.3，纯依赖解析方式变更，风险最低」），且**与对标物 OpenClaw 的实际做法相反**——见下方「口径更正」。

---

## 口径更正（关于「对标 OpenClaw v2026.5.28 的做法」）

> ⚠️ **此处更正**：`P10-52` 原文把「内化 agent-core」描述为「对标 OpenClaw v2026.5.28 的做法」，**此表述不准确，保留以留痕**。

实测 OpenClaw（`~/Desktop/project/openclaw`）：

| 维度 | OpenClaw 实际做法 | 是否「内化/vendor 源码」 |
| --- | --- | --- |
| Pi 依赖形式 | `package.json` 钉 `@earendil-works/pi-*` @ **0.75.5**（registry 发布包） | 否 |
| 接入方式 | SDK 嵌入（`Agent` / `runAgentLoop`）+ 编程式注入 `extensionFactories` | 否 |
| 源码是否在场 | 否（黑盒 `dist`，与 `DEV_SPEC.md:84` 同构） | 否 |
| import 面（参考） | `agent-core` 216 / `ai` 195 / `coding-agent` 98 / `tui` 23 处 | — |

→ **OpenClaw 同样是「registry 钉版本黑盒」，并不 vendor Pi 源码**。「对标 OpenClaw」在事实上**是反对内化的论据**，而非支持。正确的对标结论是：*沿用 OpenClaw 的「钉版本黑盒 + SDK 嵌入 + extensionFactories 注入」三件套，不在本仓内化 Pi 内核*。

（注：`P10-52` 措辞为 v2026.5.28，本仓 §2.5 详细分析依据的是 v2026.5.27 / 0.75.5；两版在「是否 vendor 源码」这一点上无差异，不影响结论。）

---

## 现状核对（已实测，非推测）

1. **当前依赖面**（`package.json:21-24`）：四包全部精确钉 `0.80.3`。
2. **黑盒代价已记录**（`DEV_SPEC.md:184`）：发布包 `files: ["dist"]`，仅含 `.js` + `.d.ts` + `.d.ts.map`，**无 `.ts` 源码 → 无法 step-debug 进 Pi 循环**。
   - 已有缓解：`dev:pi-local` / `dev:pi-registry` 一键切换脚本，深挖时临时切回本地源码链接，用完切回（不进生产路径）。
3. **三道闸门已挂在 Pi 循环内**（非需改 loop 内核）：`permission-gate` / `audit-hook` / `job-apply` 经 `extensionFactories` 注入（`DEV_SPEC.md:180`「闸门② 走 extension 而非 pi-host 自研」）。即当前**没有 loop-kernel 级 patch 的硬需求**。

---

## 内化 vs 现状：收益 / 风险 / 工作量

| 维度 | 内化 `agent-core`（vendor 源码） | 现状（钉版本黑盒） |
| --- | --- | --- |
| **可调试性** | ✅ 可 step-debug 进循环内核 | ❌ 黑盒（靠 `dev:pi-local` 临时缓解） |
| **loop 内核可改** | ✅ 可改 compaction / 事件分发 / tool_result 改写语义 | ❌ 只能走 extension 钩子通道 |
| **行为确定性** | ⚠️ 任何 divergence 由本仓承担，丧失「零行为变化」保证 | ✅ 上游不动则行为不动 |
| **维护负担** | ⚠️ 高：Pi 0.x 快速迭代，minor 可能 breaking，需建立同步机制 | ✅ 低：只 bump 版本号 |
| **与 OpenClaw 同构** | ❌ 偏离（OpenClaw 不 vendor） | ✅ 同构，对齐上游心智负担低 |
| **升级成本** | ⚠️ vendor 后升级 = 重 merge 上游改动 | ✅ 升级 = bump 版本 + 跑测试 |

**内化唯一不可替代的收益**：拿到 loop 内核级的控制权（step-debug + 改内核语义）。但当前三道闸门都经 `extensionFactories` 满足，**该收益暂无对应的真实需求**；且 `dev:pi-local` 已覆盖「临时深挖」场景。

**内化的核心代价**：fork drift。Pi 处于 0.x（`DEV_SPEC.md:182` 已确认「0.x minor 可能含 breaking，OpenClaw 自身停在 0.75.5」说明上游节奏不稳），vendor 后即承担持续 re-sync 成本，与 P7「最低风险」原则直接冲突。

**工作量估算**（若未来启动）：
- vendor 三包源码（`agent-core` / `ai` / `coding-agent`，参考 OpenClaw import 面 216/195/98）+ `pi-tui` 视入口决定；
- 改造构建：`tsconfig.paths` 指向 in-repo 源码、移除 `package.json` 中 3 条 Pi 依赖、harness 接入点对齐；
- 核对 0.80.3 d.ts 与 vendor 源码差异（参照 P8-39 落表口径）；
- 全量测试回归 + 新增「源码级调试」验证场景；
- 长期：建立上游同步 cadence（watch Pi release + 定期 re-merge）。
- 一次性强度约 **1–2 周**，叠加**持续同步成本**（取决于 Pi 发布频率）。

---

## 立项建议

**立项为长期选项（P10-52-backlog），不进入当前迭代。**

- 当前默认方案维持「registry 钉 0.80.3 黑盒 + SDK 嵌入 + `extensionFactories` 注入」，与 OpenClaw 同构、风险最低。
- 下述**任一激活条件**出现时，重启本评估并进入实现：
  1. 出现 `extensionFactories` 钩子通道**无法满足**的 loop 级需求（如：自定义 compaction 语义、loop 内事件级审计捕获、拦截 agent 内部 tool-call 编排顺序）；
  2. step-debug 缺口成为高频阻塞，且 `dev:pi-local` 临时切换成本不可接受；
  3. Pi 上游进入稳定 1.x 且发布节奏收敛，vendor 同步成本显著下降。
- 激活前不投入任何实现工作；本仓继续依赖发布包。

---

## 后续动作

- [x] 评估完成，结论：内化 ≠ 对标 OpenClaw，暂不执行。
- [x] `DEV_SPEC.md` `P10-52` 标记完成（本章作为立项依据归档于 `docs/`）。
- [ ] 长期 backlog 跟踪：在出现上述激活条件时重启评估。
