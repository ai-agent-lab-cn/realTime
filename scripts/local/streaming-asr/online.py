#!/usr/bin/env python3
"""Experimental stateful sherpa-onnx adapter. No microphone or network access.

stdin: JSON lines start(sampleRate=16000), audio(sequence, sampleEndMs, pcm),
finish, cancel. PCM is base64 little-endian mono Float32, normalized [-1, 1].
stdout: ready/started/cancelled and partial/endpoint/complete JSON lines only.
sequence is zero-based and contiguous within each start; sampleEndMs is the
cumulative duration of actual PCM. endpoint is an acoustic/window boundary,
never a bilingual application Final. complete.text joins every finished segment.

The 0.66 s synthetic tail follows the upstream online-decode-files.py example:
https://github.com/k2-fsa/sherpa-onnx/blob/master/python-api-examples/online-decode-files.py
It is declared separately and never advances the real-input sample clock.
"""
import argparse
import array
import base64
import binascii
from contextlib import redirect_stdout
import json
import math
from pathlib import Path
import sys


SAMPLE_RATE = 16000
MAX_SEGMENT_SAMPLES = 12 * SAMPLE_RATE
TAIL_SAMPLES = 10560  # 0.66 seconds, upstream file decoder's right-context tail.
MODEL_FILES = {
    "tokens": "tokens.txt",
    "encoder": "encoder-epoch-99-avg-1-chunk-16-left-128.onnx",
    "decoder": "decoder-epoch-99-avg-1-chunk-16-left-128.onnx",
    "joiner": "joiner-epoch-99-avg-1-chunk-16-left-128.onnx",
}


class OnlineAdapter:
    """One resident recognizer; fresh per-session streams and bounded windows."""

    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.stream = None
        self.state = "idle"

    def handle(self, message):
        if not isinstance(message, dict):
            raise ValueError("command must be a JSON object")
        kind = message.get("type")
        if kind == "start":
            if self.state == "active":
                raise ValueError("start requires finish or cancel of the active session")
            if type(message.get("sampleRate")) is not int or message["sampleRate"] != SAMPLE_RATE:
                raise ValueError("sampleRate must be the integer 16000")
            self.stream = self.recognizer.create_stream()
            self.state = "active"
            self.sequence = -1
            self.total_samples = 0
            self.segment_samples = 0
            self.segment = 0
            self.last_text = ""
            self.completed = []
            self.padding_samples = 0
            return [{"type": "started"}]
        if kind == "cancel":
            self.stream = None
            self.state = "cancelled"
            self.completed = []
            self.last_text = ""
            return [{"type": "cancelled"}]
        if kind == "finish":
            if self.state in ("finished", "cancelled"):
                return []
            self._require_active()
            events = []
            if self.segment_samples:
                self._finish_stream(events)
            text = " ".join(self.completed + ([self.last_text] if self.last_text else []))
            events.append(self._event("complete", text, syntheticPaddingSamples=self.padding_samples))
            self.stream = None
            self.state = "finished"
            return events
        if kind != "audio":
            raise ValueError("unknown command type")
        self._require_active()
        samples = self._validate_audio(message)
        self.sequence = message["sequence"]
        events = []
        offset = 0
        while offset < len(samples):
            count = min(len(samples) - offset, MAX_SEGMENT_SAMPLES - self.segment_samples)
            self.stream.accept_waveform(SAMPLE_RATE, samples[offset:offset + count])
            self.segment_samples += count
            self.total_samples += count
            offset += count
            self._drain(events)
            if self.segment_samples == MAX_SEGMENT_SAMPLES:
                # input_finished plus right context preserves the undecoded tail.
                # That exhausted stream cannot receive new audio, so replace it.
                self._finish_stream(events)
                self._close_segment(events, "hard_limit")
                self.stream = self.recognizer.create_stream()
            elif self.recognizer.is_endpoint(self.stream):
                self._close_segment(events, "acoustic")
                self.recognizer.reset(self.stream)
        return events

    def _require_active(self):
        if self.state != "active":
            raise ValueError("audio/finish requires an active start")

    def _validate_audio(self, message):
        sequence = message.get("sequence")
        if type(sequence) is not int or sequence != self.sequence + 1:
            raise ValueError(f"sequence must be the next integer {self.sequence + 1}")
        pcm = message.get("pcm")
        if not isinstance(pcm, str):
            raise ValueError("pcm must be base64 Float32 little-endian")
        # Bound allocation before decoding. Large source audio must be chunked.
        if not pcm or len(pcm) > ((MAX_SEGMENT_SAMPLES * 4 + 2) // 3) * 4:
            raise ValueError("audio chunk must contain 1 sample to 12 seconds of PCM")
        try:
            raw = base64.b64decode(pcm, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("pcm is invalid base64") from error
        if not raw or len(raw) % 4 or len(raw) > MAX_SEGMENT_SAMPLES * 4:
            raise ValueError("pcm must contain whole Float32 samples, at most 12 seconds")
        samples = array.array("f")
        samples.frombytes(raw)
        if sys.byteorder != "little":
            samples.byteswap()
        if any(not math.isfinite(x) or abs(x) > 1 for x in samples):
            raise ValueError("pcm samples must be finite and normalized to [-1, 1]")
        end = message.get("sampleEndMs")
        expected = (self.total_samples + len(samples)) * 1000 / SAMPLE_RATE
        if (type(end) not in (int, float) or not math.isfinite(end)
                or not math.isclose(end, expected, rel_tol=0, abs_tol=0.000001)):
            raise ValueError(f"sampleEndMs must match cumulative PCM duration {expected}")
        return samples

    def _event(self, kind, text, **extra):
        return {"type": kind, "sequence": self.sequence, "segment": self.segment,
                "text": text, "sampleEndMs": self.total_samples * 1000 / SAMPLE_RATE,
                "segmentStartMs": (self.total_samples - self.segment_samples) * 1000 / SAMPLE_RATE,
                **extra}

    def _drain(self, events, synthetic_padding=0):
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
            text = self.recognizer.get_result(self.stream).strip()
            if text != self.last_text:
                self.last_text = text
                extra = {"syntheticPaddingSamples": synthetic_padding} if synthetic_padding else {}
                events.append(self._event("partial", text, **extra))

    def _finish_stream(self, events):
        self.stream.accept_waveform(SAMPLE_RATE, array.array("f", [0.0]) * TAIL_SAMPLES)
        self.padding_samples += TAIL_SAMPLES
        self.stream.input_finished()
        self._drain(events, synthetic_padding=TAIL_SAMPLES)

    def _close_segment(self, events, reason):
        events.append(self._event("endpoint", self.last_text, reason=reason,
                                  syntheticPaddingSamples=TAIL_SAMPLES if reason == "hard_limit" else 0))
        if self.last_text:
            self.completed.append(self.last_text)
        self.last_text = ""
        self.segment += 1
        self.segment_samples = 0


def create_recognizer(model_dir):
    """Load only the frozen fp32 Zipformer files, CPU, two threads, greedy."""
    paths = {name: str(Path(model_dir) / filename) for name, filename in MODEL_FILES.items()}
    for path in paths.values():
        if not Path(path).is_file():
            raise ValueError(f"required model file missing: {path}")
    import sherpa_onnx
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        **paths, num_threads=2, provider="cpu", sample_rate=SAMPLE_RATE,
        feature_dim=80, decoding_method="greedy_search", model_type="zipformer2",
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4, rule2_min_trailing_silence=1.2,
        rule3_min_utterance_length=20.0,
    )


def serve(recognizer, incoming, outgoing, errors):
    """Fail closed on malformed input; diagnostics never become result events."""
    adapter = OnlineAdapter(recognizer)

    def emit(event):
        outgoing.write(json.dumps(event, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        outgoing.flush()

    emit({"type": "ready"})
    for line_number, line in enumerate(incoming, 1):
        try:
            message = json.loads(line)
            # Redirect Python-level dependency logs, keeping stdout JSON-only.
            with redirect_stdout(errors):
                events = adapter.handle(message)
            for event in events:
                emit(event)
        except (ValueError, TypeError, RuntimeError) as error:
            adapter.handle({"type": "cancel"})
            errors.write(f"line {line_number}: {error}\n")
            errors.flush()
            return 2
    # EOF is cancellation, not implicit success/finish; incomplete input is lost.
    adapter.handle({"type": "cancel"})
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    try:
        with redirect_stdout(sys.stderr):
            recognizer = create_recognizer(args.model_dir)
        return serve(recognizer, sys.stdin, sys.stdout, sys.stderr)
    except (ImportError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
