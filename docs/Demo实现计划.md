# 前端 Demo 实现计划

目标：基于产品设计文档与 AGENTS.md，在 macOS 上运行 Electron + Vue 3 + TypeScript 模拟字幕 Demo。

设计：一个主页面，浅色纸面阅读区与绿色操作强调；顶部显示产品、模拟演示标识和四态状态，中央显示双语字幕，底部提供控制与设置。中文为主要阅读内容。独立的设置抽屉和确认弹窗不增加页面导航。

数据流：固定模拟语料 → 定时产生带轮次和版本的事件 → 独立字幕状态逻辑 → Pinia → Vue。暂停、结束后取消定时器并拒绝迟到事件；继续从下一段模拟语音开始，未完成字幕保留未确认标记。每轮语料播完自动结束。

范围：开始、暂停、继续、结束、重新开始、当前记录、复制、清空、双语切换、三档字号、自动滚动、内置术语开关。字幕和翻译均为模拟，不接麦克风或后端。

## 执行步骤

- [x] 配置 Vite、Vue、Pinia、Electron、Vitest、Playwright 与 TypeScript；建立可运行命令。
- [x] 在 tests/unit/session.test.ts 写规则测试，观察缺失行为失败；在 src/domain/session.ts 实现事件过滤和状态转换，再运行测试。
- [x] 在 src/demo/ 建固定演示语料，在 src/stores/ 建模拟播放与设置状态；用可控时间验证暂停、结束、继续。
- [x] 在 src/components/ 和 src/App.vue 构建字幕、设置、控制与确认流程；运行浏览器流程测试。
- [x] 在 electron/ 建隔离桌面窗口与受限剪贴板接口；验证桌面窗口、复制、无 Node 暴露。
- [x] 完成类型检查、单元测试、端到端测试、生产构建与桌面冒烟；实际检查页面截图。
- [x] 更新 README、验收记录和结果，启动 Demo 供用户体验。

文件职责：src/domain/session.ts 管状态规则；src/demo/script.ts 管语料；src/stores/interpreter.ts 管播放及设置；src/components/SubtitleFeed.vue 管阅读；src/components/SettingsPanel.vue 管设置；src/App.vue 管页面编排；electron/main.ts、preload.ts 管桌面窗口与剪贴板。项目尚无 Git 仓库，不创建无关 worktree 或提交。

验证：npm run typecheck、npm test、npm run test:e2e、npm run build、npm run test:electron。真实音频质量、真实延迟、麦克风权限和签名分发均不属于本次 Demo 验收。
