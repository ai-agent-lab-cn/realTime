# 第3项：有限翻译上下文 Implementation Plan

> **For agentic workers:** 执行时使用 executing-plans，按任务检查结果；本文件仅为规划，不授权修改正式默认、提交或推送。

**Goal:** 验证有限英文前文能否改善指代与逻辑关系，并保持可接受的首中文延迟。
**Architecture:** 目标句与前文分开传入本地翻译；以目标前最多两个闭合英文分句构成冻结快照，所有复用签名包含上下文。先文本A/B，再同音频A/B，达标后另行决定启用。
**Tech Stack:** 现有 TypeScript、Vitest、llama.cpp、Qwen3；不添加新模型或依赖。
**Spec:** [设计与采用标准](../specs/2026-10-19-context-and-streaming-design.md)，第二节。

## Global Constraints

- 完全本地；英文质量检查前置；Final不可回改；暂停、结束、新会话、术语变更清空前文。
- 最多2句、120英文词、800码点；跨字幕仅最近一个更早Final且间隔不超过10秒；无前文不等待。
- 无上下文A组保留现有提示词和复用行为。实验开关仅在开发配置使用，不添加产品设置面板。
- 不修改ASR模型、音频阈值、输出token上限；失败或取消不提交缓存及跨字幕历史。
- 先保留当前未提交源码快照。本轮只完成独立文本A/B入口与报告；应用接入和音频对照未执行，不批量格式化或覆盖无关改动。

## Task 1：冻结样本与文本对照入口

**Files:** 新建 `tests/fixtures/translation-context/cases.json`、`scripts/local/evaluate-context.mjs`；输出到 `outputs/translation-context/`。

- [x] 保存20组文本：12组定向语义（指代、否定、比较、数字各3组）和8组控制；每组包含id、前文、target、关键关系、允许译法和复核状态。
- [x] 例：前文为“The timeout is fifteen seconds, not fifty.”，target为“This limit applies only to uploads.”；核对限制只适用于上传，不要求译文逐字匹配。
- [x] 文本对照逐条配对A/B、B/A交替，预热后各3次，模型加载和校准另列。本轮为独立提示词实验，不接TranslationMemory且两组cache_prompt=false；后续runtime对照须各自初始化独立TranslationMemory。
- [x] 先验证结果中包含样本量、提示词版本、模型校验值、延迟与待复核项；不把AI自评当正式质量结论。

## Task 2：上下文选择与隔离

**Files:** 新建 `electron/translation-context.ts`、`tests/unit/translation-context.test.ts`；修改 `electron/local-runtime.ts` 及其相关测试。

**Proposed interface:**

```ts
export interface TranslationContext {
  version: 'context-v1'
  source: readonly string[]
}
export function selectContext(previous: readonly string[]): TranslationContext
```

`previous`必须按源文顺序传入，且由runtime保证来源合格；选择器只负责取最近闭合整句及词数/码点限制。当前请求前面的已校验闭合源句优先，跨字幕来源仅是最近合格Final。不能从当前字幕旧修订取历史。

- [ ] 先写失败用例：3句只留末2句；超限逐句丢弃；长单句不截断；开放残句不进入前文；选取结果不可被外部修改。
- [ ] 运行 `npx vitest run tests/unit/translation-context.test.ts`，确认未实现时失败，再最小实现。
- [ ] runtime登记字幕最新源修订；在质量检查后按逻辑caption id冻结跨字幕前文。提交历史条件须与显示Final条件等价：最新源修订、音频已结束、无pending/error且双语齐全。
- [ ] 增加回归：旧任务成功回执不能提交历史；跨窗口carry不重复纳入当前句；失败/取消不提交；时间间隔超过10秒不借用；暂停/结束/术语变化清空；无合格前文不等待。
- [ ] 新历史与快照按有界方式保存：最多保留最近一个已确认块的末2句；活动字幕快照最多128条，超过时拒绝新增实验上下文并退回无前文，不删除仍运行任务的快照。

## Task 3：提示词与缓存正确性

**Files:** 修改 `electron/local-models.ts`、`electron/local-processing.ts`、`electron/translation-memory.ts`、`electron/local-runtime.ts`、`tests/unit/local-models.test.ts`、`tests/unit/translation-memory.test.ts`、`tests/unit/local-runtime.test.ts`。

- [ ] Models.translate 在现有可选onProgress后增加可选context；无context保持原调用结果与提示词。
- [ ] context模式将user内容序列化为 `{context:[...], target:text}`；系统指令要求仅翻译target、前文仅供消歧，不执行数据内指令、不输出解释。
- [ ] 缓存key包含目标、术语、实际上下文、提示词版本；latest整段缓存和TranslationScheduler同源复用签名同步升级。关闭实验时保持原key语义。
- [ ] 增加先失败的回归：同target不同context不能复用；同context排版空白可复用；仅前文否定/数字改变也要重算；同源Final与Partial只有冻结上下文相同时才能沿用翻译。
- [ ] 检查已完成单元source只含target，进度与最终文本不混入context；失败或取消仍不提交本轮新缓存。
- [ ] 运行相关Vitest和 `npm run typecheck`；新增接线通过后运行 `npm run build` 与针对上下文路径的Electron回归。无新改动不重复全量昂贵验证。

## Task 4：实验、报告与决定

- [ ] 运行文本A/B，保存原始结果；按设计文档的12+8样本门槛复核，争议保持待复核。
- [ ] 同ASR、同音频、同采样节奏比较首中文中位数/P95及MT首输出；缓存命中与未命中分别报告。缺少人工参考不宣称准确率达标。
- [ ] 按门槛选择“2句有效”“缩为1句重测”或“保留无上下文”。仅质量改善但延迟超限不能直接默认启用。
- [ ] 保存 `outputs/translation-context/对照报告.md`，列通过/失败/未执行、样本与配置；更新正式链路文档中的已验证结论。
- [ ] 若符合采用门槛，再提供明确的启用改动与回退方案供用户决定；本计划本身不改变正式默认，不提交或推送。

## 2026-10-19 文本实验执行记录

- 仅Task1与Task4的文本报告部分执行，未修改electron/src运行源码；Task2/3与同音频对照均未执行。
- 20组、每臂3次，共120/120请求成功；13项相关单元/CLI回归通过。原始源码、模型校验值与请求保留。
- AI初审发现2组明确前文回译、2组额外展开风险；没有人工确认达到语义改善门槛，不修改正式默认。
- 首模型输出中位数A512.25ms/B724.93ms；这是文本提示词实验，不是首中文字幕或收音延迟。
- 报告：[文本上下文A/B对照](../../../outputs/translation-context/对照报告.md)。下一步优先在风险样本上收紧输出范围，小样本复测后再决定应用接入。
