# 第4项：原生流式 ASR 对照实验 Implementation Plan

> **For agentic workers:** 执行时使用 executing-plans，逐阶段检查；先完成识别实验，达标后才进入接翻译实验，不直接替换生产默认。

**Goal:** 在同样音频与设备上判断原生流式识别是否值得接入实译。
**Architecture:** 保留Whisper累计窗口基线，以独立有状态Streaming Zipformer适配器做实时节奏回放。先ASR，再固定翻译配置测双语链路；质量、延迟、资源和离线能力共同决定采用。
**Tech Stack:** 现有Node/TypeScript回放与本地Whisper；候选sherpa-onnx Python实验适配器，使用项目内独立实验环境，不写入正式应用依赖。
**Spec:** [设计与采用标准](../specs/2026-10-19-context-and-streaming-design.md)，第三节。

## Global Constraints

- 当前默认Whisper不变；不同时启用两个识别引擎；第3项对照期间不改ASR。
- 流式输入保留状态，不重复提交累计PCM；英文先质量检查，endpoint不直接等同于双语Final。
- 完全本地；不新增会议、云端API、系统音频或产品切换面板。
- 本轮规划未下载候选；执行时先核验来源、版本、权重许可、哈希与macOS arm64可运行性。
- 模型放models，环境与构建放work，报告放outputs；模型/课程/本机结果不提交Git。

## 执行结果（2026-10-19）

**No-Go：此固定候选不替换Whisper。** 首轮26段双臂52次成功；16段人工确认课程WER由3.65%升至35.62%，超过预设1个百分点回退门槛。按计划停止此候选后续轮次及翻译接入，未降低门槛或删除失败样本。完整证据见 [ASR对照报告](../../../outputs/streaming-asr/ASR对照报告.md)。

原计划156次中52成功、1条因停止信号主动取消、103未开始，不能称为完成3轮或发布验收。

## Task 1：固定候选与可比较语料

**Files:** 新建 `scripts/local/streaming-asr/README.md`、`scripts/local/streaming-asr/candidate.json`、`tests/fixtures/streaming-asr/manifest.json`。

- [x] 固定候选 `sherpa-onnx-streaming-zipformer-en-2023-06-26`。先用文档所列fp32、CPU、2线程、greedy_search路径，int8仅作为后续单独变量，不混在主对照中。
- [x] candidate.json记录运行库固定版本、权重/词表URL、各文件SHA-256、依赖版本、许可证据、实际文件大小及endpoint/编码chunk配置。运行库许可证不能替代权重许可证。
- [x] 在 `work/streaming-asr/` 建独立环境，工具获取后断网验证；失败保留具体原因，不宣称候选已支持本机。
- [x] 冻结20～30段固定样本及其哈希：英文课程、日常、技术、数字/否定、长句、噪声、中英混合；保留现有失败样本，课程草稿参考仍标pending。
- [x] 参考未确认时允许跑工程延迟与输出观察；不计算正式WER或写“质量通过”。人工听校此前暂搁，本实验不视作重新完成或重新授权。

## Task 2：有状态回放适配与确定性验证

**Files:** 新建 `scripts/local/streaming-asr/online.py`、`scripts/local/compare-asr.mjs`、`tests/unit/streaming-replay.test.ts`；复用 `src/audio/segmenter.ts` 和现有LocalRuntime作为A组。

**实验协议：** 子进程stdin按行接收JSON；PCM为base64 Float32单声道数据；stdout只发结果JSON，调试输出到stderr。仅在本机实验使用，不开放网络端口。

```ts
type StreamingInput =
  | { type: 'start'; sampleRate: 16000 }
  | { type: 'audio'; sequence: number; sampleEndMs: number; pcm: string }
  | { type: 'finish' }
  | { type: 'cancel' }
type StreamingOutput = {
  type: 'partial' | 'endpoint' | 'complete'
  sequence: number
  segment: number
  text: string
  sampleEndMs: number
}
```

- [x] 先用模型替身写失败用例：每100ms推进1600个采样点，每点仅送一次；不能预送未来音频；sequence乱序拒绝；finish仅排空一次，cancel后忽略旧输出。
- [x] 运行 `npx vitest run tests/unit/streaming-replay.test.ts` 确认先失败；再实现调度与协议校验。Node侧记录收发时间，不能直接相减Python与Node单调时钟。
- [x] online.py按官方OnlineRecognizer流程保持stream状态，accept_waveform后在is_ready时解码；endpoint标记声学边界，finish排空，cancel释放。不要循环对完整累计音频新建recognizer。
- [x] A组接收同一节奏PCM并走原segmenter/质量检查；B组输出也通过同一质量检查。两组实际分段策略差异全部列出，不以强迫B组等满1.5秒制造虚假公平。
- [x] B组ASR-only已落实12秒片段硬上限并记录自身endpoint关系；不含翻译尾句等待或页面Paused。应用层最多两个窗口的残句衔接仍属于下方Task4接入门槛，本轮未实施。
- [x] 选一段已有数字样本做离线冒烟，核对完整文本、增量事件与取消；这不是质量或性能验收。

## Task 3：识别A/B与判定

**Files:** 新建 `scripts/local/streaming-asr/metrics.mjs`；输出 `outputs/streaming-asr/asr-results.json` 与 `ASR对照报告.md`。

- [x] 首轮配对A/B、B/A交替、启动/校准另列、推理串行；已记录线程与试次末资源快照，温度缺失。原计划每臂3次，首轮质量失败后停止其余重复。
- [ ] 记录首非空输出与首有效输出。有效片段须人工确认表达实际内容，不能把“because”等孤立引导词算通过；稳定片段指其内容直到该语句结束不再改写，事后核对事件序列。
- [x] 按固定参考计算最终英文WER；统一大小写与标点规则，保留关键数字/否定单独检查；混合输入另列字符/词与语义，不套用纯英文分母。
- [ ] 按每段3次的中位数再跨样本汇总n/中位数/P95；未确认参考、未人工确认有效片段、缺少起止标注全部单列。
- [x] 按设计文档门槛：有效英文中位数同时降低25%且300ms，P95与稳定片段不变差；WER允许最多增加1个百分点且无新增严重语义错误。未满足则停止此候选，保留基线。

## Task 4：双语实验与接入决定

**Files:** 识别门槛通过后新建 `scripts/local/streaming-asr/translation-bridge.mjs`、相关集成回归；输出 `outputs/streaming-asr/双语链路报告.md`。本任务不修改正式桌面入口。

- [ ] 固定第3项作出选择后的翻译配置；B组接入相同质量检查、断句、分句翻译/缓存与完成通知。新增流式接口不能仅塞回当前recognize(cumulativePcm)冒充接入。
- [ ] 先补回归：声学endpoint不直接Final；双语齐备、最新修订才Final；暂停/取消丢弃旧流，继续新建状态；重复和乱序通知不追加；缺标点与长残句不会无限等待。
- [ ] 同音频测首中文、完整有效片段、双语Final与重复翻译成本。若无标点影响现有断句，列为失败原因；需要标点模型时另立候选，明确额外延迟，不静默补入。
- [ ] 进行30分钟固定输入持续回放，检查队列、峰值RSS与内存趋势、丢失/重复、静音、快速暂停继续；不得以平均RTF<1代替长时证据。
- [ ] 采用门槛：首中文中位数回退≤150ms、P95≤300ms；识别质量门槛持续满足，长时及生命周期通过。混合语音退化必须报告，不能自动全局替换多语言Whisper。
- [ ] 输出“建议正式接入 / 调整后重测 / 保留Whisper”，列未执行项目。只有识别通过时标“ASR实验通过，产品接入待验”。正式Electron/IPC接入另给明确改动方案，不在实验中自动上线。

### 验证与遗留

- 25项相关Vitest与13项Python回归通过；独立审查的候选配置、IPC取消、终态评分、末段边界缺陷已先复现再修复。
- 首个有效语义的人工时间戳未标注；已记录质量门首输出与机械稳定前缀，未冒充正式有效字幕延迟。
- 仅一轮可用于当前No-Go，不计算三轮重复分布。原始及派生覆盖都保留，全部样本仍在清单。
- 16段课程使用已有正式人工作业；非重新启动已暂搁的听校。negation存疑与混合/静音分母保持原规则。
- Task4未满足前置质量门槛，翻译链路、30分钟、Electron默认接入与打包验收未执行。未提交或推送。
