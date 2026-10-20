# 英文独立显示与分句翻译 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 按用户已确认的两轮方案，解除英文识别对翻译的等待，避免新一轮译文清空旧译文，并复用完整分句。

**Architecture:** ASR 与 MT 各自串行、相互独立。新增 recognize IPC 在识别与任务入队后返回，翻译通过已有 translated 通知发布 progress/complete；旧 transcribe 保留完整响应用于文件评测。ASR 返回的临时原文先显示，随后检查异常并规划断句；所有最终确认仍依赖校验和完整翻译。以精确英文分句及术语设置缓存译文，跨请求保留已显示中文，修正仅替换未确认部分。

**Tech Stack:** Electron、Vue 3、TypeScript、Pinia、Vitest、Playwright；既有 whisper.cpp / llama.cpp。

**Spec:** 本任务用户确认的两轮方案与 ASR 后前置英文显示要求；产品范围见 docs/产品设计文档.md。

## Global Constraints

- 运行时完全本地；不录音、不上传；不更换模型与音频分段阈值。
- Final 不可回改；暂停、结束、新会话隔离旧任务；Final 积压不得静默丢弃。
- 用户明确同意 ASR 后先临时显示，再质量检查；异常必须标记，不能成为 Final。
- 保留此前未提交修改，已快照到 work/pipeline-baseline；不自动提交或推送。
- 当前项目目录及本地模型用于实机验证，不迁移正式文件。

## Task 1: 后端两阶段调度

Files: electron/local-runtime.ts、electron/local-types.ts、electron/translation-scheduler.ts（新增）、electron/main.ts、electron/preload.cts；tests/unit/local-runtime.test.ts、tests/unit/translation-scheduler.test.ts。

Interfaces:
- `LocalRuntime.recognize(request, onRecognized?, onTranslated?, onComplete?): Promise<LocalTranscript>` 返回识别确认回执，后台翻译；`transcribe` 保留完整结果语义。
- `LocalBridge.recognize?` 与 `LocalTranslation.phase?: 'progress' | 'complete'`、`audioFinal?: boolean`；识别通知允许携带 caption 路由。
- `TranslationScheduler.run(key, final, signal, work)`：单 MT 活动任务，合并待处理 Partial，保留最多 3 个待处理 Final；超限显式报错。

- [x] 写失败测试：MT 被手动挂起时，下个 ASR 能返回；异常 ASR 先发临时原文随后拒绝翻译；未完成 MT 时仍能建立相邻窗口衔接；取消阻止晚到回调；队列 Final 不丢弃。
- [x] 执行 `npm test -- tests/unit/local-runtime.test.ts tests/unit/translation-scheduler.test.ts`，核对缺失行为导致的失败。
- [x] ASR 识别锁与 MT 控制器分开；在识别阶段建立 carry，MT 完成不得恢复旧会话；队列监听 abort 清除任务。
- [x] 主进程复用授权检查，新 IPC 发布分阶段通知；旧完整请求和诊断回放保持可用。
- [x] 复测相关单元测试与类型检查；仅对确实变化的通知顺序更新旧断言。

## Task 2: 前端英文、中文独立修订

Files: src/domain/localCaptions.ts（新增）、src/stores/interpreter.ts、src/composables/useLocalInterpreter.ts；tests/unit/local-captions.test.ts、tests/unit/local-interpreter.test.ts。

Interfaces:
- `LocalCaptionUpdates` 绑定 Session，以 `recognize(segment, result, epoch)` 和 `translate(segment, result, epoch, complete)` 分别维护英文、译文修订；caption 元数据用于两窗口统一 id。
- 新桥接模式由 `bridge.recognize && bridge.onTranslated` 决定；旧测试桥接仍支持完整 transcribe。

- [x] 写失败测试：已有中文时新英文立即更新且保留中文；新流首块变短不回退；旧 MT 不回滚新英文；Final 仅在匹配最新识别的完整翻译时确认；换 epoch 后旧结果无效。
- [x] `npm test -- tests/unit/local-captions.test.ts tests/unit/local-interpreter.test.ts` 确认失败。
- [x] 完成独立修订与跨轮中文保留；同一活动译文内允许术语大小写规范化；新一轮重译完成后才替换有差异的未确认尾部。
- [x] recognize 回执释放 ASR 队列；翻译通知独立接收，按 session/request/caption 检查顺序；质量失败和翻译失败均保留原因，连续三个最终窗口失败才暂停。
- [x] 复测桥接和生命周期用例。

## Task 3: 分句复用与真实验证

Files: electron/translation-memory.ts（新增）、electron/local-runtime.ts、README.md、tests/unit/translation-memory.test.ts、tests/e2e/local-electron.spec.ts；输出证据 outputs/independent-pipeline/。

Interface:
- `TranslationMemory.translate(text, terms, signal, translate, onProgress?)` 按完整句边界拆分，精确复用已有分句，最多缓存 128 条；不猜测未知词，不从句号推定整条字幕 Final。

- [x] 先测试 `Costs are high.` → `Costs are high. Returns rise.` 只翻译新增句；改变前句时重新翻译该句；小数、缩写和省略号不误拆；不同术语设置及新会话隔离缓存。
- [x] 观察失败后实现最小分句缓存；缓存只在正常完成时写入，取消请求不提交新缓存。
- [x] 跑完整单元、构建、Electron 模拟与真实模型固定音频回放。
- [x] 同段课程对照 ASR 提交/完成/英文显示、MT 首输出/完成及积压；保存未提交基线，报告实际改善和回归。
- [x] 独立代码审查；修复有效问题后仅重跑受影响检查；更新 README 与验证报告。

## 后续约定修订

用户随后明确替换 AGENTS.md，恢复“原文提前通知必须经过质量检查”。已于本轮延迟优化落实；英文仍不等待断句和 MT，历史计划的先显示后检查仅描述当时确认的实现。
