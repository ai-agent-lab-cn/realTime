# Streaming ASR 独立对照候选

本目录用于第 4 项 ASR 对照实验。正式 Electron / `src` 默认仍为 Whisper；实验环境、权重不加入应用依赖。

## 已固定候选

- 官方维护来源：[sherpa-onnx 英文候选文档](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html#sherpa-onnx-streaming-zipformer-en-2023-06-26-english)。该模型只支持英文，不能据此承诺中英混合识别能力。
- 导出权重：[csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/tree/672fbf1b30579d6585301139bb363f42a0ad4a24)，revision `672fbf1b30579d6585301139bb363f42a0ad4a24`。
- 只取 `encoder`、`decoder`、`joiner` 的 `epoch-99-avg-1-chunk-16-left-128.onnx` fp32 文件和 `tokens.txt`。不下载 int8，不改现有 Whisper / 翻译模型。
- 全部 URL、字节数、SHA-256、配置和本机证据路径以 [candidate.json](candidate.json) 为准。三个 ONNX 的 SHA 与固定 revision 的 HF LFS SHA 相符；词表以固定 Git blob 和实下载 SHA 固定。
- 2026-10-19 查 PyPI 最新为 `sherpa-onnx==1.13.8`；已实际安装 cp39 macOS arm64 wheel。独立环境为 `work/streaming-asr/venv/`，Python 3.9.6 arm64，另固定 `sherpa-onnx-core==1.13.8`、`numpy==2.0.2`。依赖冻结和 wheel 哈希保存在 `work/streaming-asr/`。

## 权重许可证据与边界

[固定 revision 的导出权重模型卡](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26/blob/672fbf1b30579d6585301139bb363f42a0ad4a24/README.md) **独立声明 `license: apache-2.0`**，因此允许依据导出发布方声明开展本地实验。这不是用运行库 Apache-2.0 代替权重许可。模型卡和 Apache-2.0 原文随模型保存，哈希已固定。

模型卡链接的[原始 checkpoint](https://huggingface.co/Zengwei/icefall-asr-librispeech-streaming-zipformer-2023-05-17/tree/37cb5606808f3d5e55a3fc73554bdf757d82465a)在其固定卡片和 API 元数据中没有单独许可证声明，只链接训练代码。本次核验覆盖导出发布方声明，不代表已完成上游权利链法律审计；正式分发模型包仍待独立审查。LibriSpeech 训练来源不等于自动获得所有衍生权利。

## 获取与校验

以下命令在项目根目录运行；首次获取工具、权重需联网，识别过程只读本地文件，不上传音频。

```sh
cd /Users/zrr/Desktop/实译
python3 -m venv work/streaming-asr/venv
work/streaming-asr/venv/bin/python -m pip install --index-url https://pypi.org/simple --cache-dir work/streaming-asr/pip-cache sherpa-onnx==1.13.8 sherpa-onnx-core==1.13.8 numpy==2.0.2
work/streaming-asr/venv/bin/python scripts/local/streaming-asr/fetch_candidate.py
work/streaming-asr/venv/bin/python scripts/local/streaming-asr/fetch_candidate.py --verify-only
work/streaming-asr/venv/bin/python -m pip freeze --cache-dir work/streaming-asr/pip-cache > work/streaming-asr/requirements-freeze.txt
```

下载脚本只接受指定新模型目录，写入 `.part`，校验大小和 SHA 后再改为正式文件。已存在且校验失败的正式文件会报错，避免覆盖。`--verify-only` 不联网、不写文件。许可证文件与四个模型文件一起验证。

本机已缓存 wheels，可用相同 Python ABI / macOS arm64 环境离线重建：

```sh
work/streaming-asr/venv/bin/python -m pip install --no-index --find-links work/streaming-asr/wheels -r work/streaming-asr/requirements-freeze.txt
```

## 固定识别配置

CPU、2 线程、`greedy_search`、16 kHz 单声道、80 维特征。模型文件名为 Zipformer，**实际 ONNX metadata 的 `model_type` 为 `zipformer2`**；显式指定 `zipformer` 会报缺少 `attention_dims`，失败日志保留于 `work/streaming-asr/evidence/failed-explicit-zipformer-model-type.stderr.log`。

文件名的 `chunk-16` 和 `left-128` 是导出设置。内嵌 metadata 为 `decode_chunk_len=32`、`T=45`、`left_context_len=128,64,32,16,32,64`；保留有状态 stream，由 `is_ready` 决定何时解码，不能按文件名猜测并覆盖内部张量配置。

保留官方 endpoint 默认 2.4 / 1.2 / 20 秒。实验 wrapper 在 12 秒硬上限处另行结束和重建 stream；该边界不等于双语 Final，不回改已确认字幕。音频以 100 ms 节奏单次提交每个采样点，不重复提交累计 PCM。

## 无音频离线加载验证

2026-10-19 已在 macOS arm64 下用 `sandbox-exec` 的 `(deny network*)` 验证识别器构造和空 stream 创建；没有提交音频，没有访问麦克风。结果见 `work/streaming-asr/evidence/offline-load-smoke.json`，stderr 为空。此项只证明本机可离线加载，不能证明识别质量、延迟或长时稳定性。

可复现的零音频检查：

```sh
sandbox-exec -p '(version 1)(allow default)(deny network*)' work/streaming-asr/venv/bin/python - <<'PY'
import json
from pathlib import Path
import sherpa_onnx
c = json.loads(Path('scripts/local/streaming-asr/candidate.json').read_text())
p = Path('models') / c['id']
r = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=str(p / 'tokens.txt'),
    encoder=str(p / 'encoder-epoch-99-avg-1-chunk-16-left-128.onnx'),
    decoder=str(p / 'decoder-epoch-99-avg-1-chunk-16-left-128.onnx'),
    joiner=str(p / 'joiner-epoch-99-avg-1-chunk-16-left-128.onnx'),
    num_threads=2, provider='cpu', model_type='zipformer2',
    decoding_method='greedy_search', sample_rate=16000, feature_dim=80,
    enable_endpoint_detection=True, rule1_min_trailing_silence=2.4,
    rule2_min_trailing_silence=1.2, rule3_min_utterance_length=20.0,
)
s = r.create_stream()
assert r.get_result(s) == ''
print('offline model load passed; submitted audio samples: 0')
PY
```

受限执行环境可能禁止嵌套 `sandbox-exec`；这属于运行权限限制，应在允许该程序的本机环境中执行同一禁网命令，不能将未执行记为通过。

质量、正式 WER、真人有效片段和 30 分钟持续运行是后续独立验收项；只完成本候选准备不代表通过 ASR 对照，也不触发正式应用替换。


## 实测结论与回放入口（2026-10-19）

本固定候选No-Go，不替换项目默认。首轮26音频×双臂=52成功，课程WER A3.65%/B35.62%；后续重复及翻译接入按质量门槛停止。完整结果见 `outputs/streaming-asr/ASR对照报告.md`（本机输出不提交）。

```sh
node scripts/local/compare-asr.mjs --dry-run
node scripts/local/compare-asr.mjs --case numbers --repeats 1 --smoke
# 完整首轮：真实节奏，约7分钟；不采集环境音。
node scripts/local/compare-asr.mjs --repeats 1
```

默认无参数计划每臂3轮。当前候选已质量失败，通常无需再做完整重复。每次运行创建唯一输出目录；在同一回放内A/B模型都驻留但推理严格串行，没有Qwen，未测试双语延迟。JSON保存原始终态、保留显示文本和全部进度，不将旧Partial当最终结果评分。

原实验156计划在完成52条后由控制进程按WER门槛发SIGINT，下一条已启动因而保留主动取消记录；不是脚本自身具备自动WER停止配置。若自行重跑请先选`--repeats 1`，不要把批量速度优势当作正式采用结论。
