# 分句完成更新与阶段计时 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Track steps below.

**Goal:** 已完成的新译句及时替换未确认尾部，并保留可审计的本地阶段耗时。
**Architecture:** TranslationMemory 发布已完成的闭合分句前缀；显示层按源文本和修订隔离单元更新。主进程与页面分别用各自单调时钟记录阶段，页面提供音频采样时间线加队列后耗时的显示估算；不直接相减不同进程时钟。每次输入会话在暂停/结束时保存仅含耗时的 JSON。
**Tech Stack:** 现有 Electron、Vue、TypeScript、Vitest、Playwright；无新依赖。
**Spec:** 用户已确认第1、2项；产品范围见 docs/产品设计文档.md。

## Global Constraints
- 质量检查后提前通知英文；Final 不可回改；暂停/结束和旧会话结果隔离。
- 模型、提示词、采样节奏及缓存的取消/失败提交约束保持原样。
- 诊断中无音频、字幕、密钥、音频会话 token；仅数字编号、阶段耗时与随机诊断编号。
- 记录有界；路径由主进程系统应用数据目录确定，不接受页面任意路径。
- 第3、4项仅记录后续方向，本轮不接入。
- Ruling: 在当前目录延续现有未提交实现并保留 work/unit-timing-baseline 快照；不创建会丢失当前改动的新 worktree，不提交或推送。

## Task 1: 分句完成元数据
- [x] 先复现修正第二句而第三句仍在生成时，第二句等待整轮完成的问题。
- [x] LocalTranscript 增加 units?: {source:string;zh:string}[]，只含已完成闭合分句前缀。
- [x] Memory 的 progress 增加可选第二参数 units；缓存命中也带元数据，取消/失败仍不提交缓存。
- [x] 显示层识别新完成分句，替换未确认尾部，重复前缀不清空旧中文；拒绝伪造/乱序单元。

## Task 2: 本地阶段计时
- [x] 独立 LocalDiagnostics 记录主进程阶段和页面测得的耗时，最多4096请求；输出样本量/中位数/P95及截断状态。
- [x] runtime 记录 ASR、质量检查、MT 排队/首输出（含缓存）/完成，不记录文本。
- [x] 页面记录采样累计、识别排队、回执和 DOM/绘制帧，时钟不跨进程相减；语音起点为能量检测代理，不冒充人工语义验收。
- [x] 受限 IPC 接收白名单数值指标，暂停/结束保存 app userData/diagnostics 下唯一JSON；保存失败不影响释放麦克风。

## Task 3: 验证与交付
- [x] 相关单元、类型检查与构建；独立审查。
- [x] 桌面 IPC/真实模型固定回放验证分句提前可见及诊断文件实际落盘；不重复无关全量测试。
- [x] 更新README、当前链路说明及本地验证报告；后续方向记录第3、4项。

验证证据：144项相关单元、5项Electron、1项真实模型固定回放、类型检查与生产构建通过。独立审查发现两项P2，均回归先红后绿并复核。详见 outputs/unit-timings/验证报告.md；真人与长时验收未执行。
