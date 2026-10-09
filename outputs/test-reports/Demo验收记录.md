# 前端 Demo 验收记录

日期：2026-10-08。范围：模拟字幕前端与 Electron 桌面窗口，不含真实音频或后端。

## 通过

- `npm test`：10 项逻辑测试通过，覆盖状态切换、重复开始、Partial 合并、Final 固定、旧版本和旧轮次隔离、暂停冻结、复制范围、清空、模拟播放结束及计时器释放。
- `npm run build`：Vue / Electron TypeScript 检查、Vite 生产构建及 Electron 编译通过。
- `npm run test:e2e`：5 项 Chrome 流程测试通过，覆盖开始暂停继续结束、复制、重新开始与清空确认、显示模式、字号、设置保存、术语开关、自动滚动、回看和窄窗口边界。
- `npm run test:electron`：1 项真实 Electron 冒烟通过，覆盖生产资源启动、字幕播放暂停、系统剪贴板及页面无 Node.js require 暴露。
- 实际检查初始页、播放页、设置面板及 600 × 760 窄窗口截图；修复初始页装饰与工具栏重叠并添加回归。
- 浏览器页面错误检查未发现 pageerror，窄窗口无横向溢出。

环境：macOS arm64；Node.js 22.22.2；Electron 39.8.10；具体依赖由 package-lock.json 锁定。浏览器测试使用本机 Google Chrome；预览端口为 5187。

## 问题与处理

- 初次测试误复用了其他项目的 5173 预览地址，已切换为独立端口 5187，并在正确页面重新运行全部浏览器测试。
- Electron 官方源及镜像传输出现停滞，通过断点续传完成下载；运行包 SHA-256 与 Electron npm 包内 checksums.json 一致后才解压执行。
- 初次 Playwright 默认 Chromium 未安装，改为使用已安装 Chrome，避免重复下载。

## 未执行 / 不在本次范围

- 真实麦克风权限、VAD、ASR、翻译服务、服务故障恢复、真实延迟与翻译质量。
- 真实音频 30～60 分钟稳定性验收。
- macOS 签名安装包、公证和 Windows 测试。

当前通过仅说明模拟 Demo 的页面与操作可用，不代表真实实时翻译产品已完成。

临时截图与测试 trace 位于 work/，运行说明见 README.md。
