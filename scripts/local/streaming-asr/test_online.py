"""Deterministic protocol tests; no model, microphone, or third-party imports."""
import base64
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
import unittest


PATH = Path(__file__).with_name("online.py")
if PATH.exists():
    SPEC = importlib.util.spec_from_file_location("streaming_online", PATH)
    online = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(online)
else:
    online = None


def audio(sequence=0, count=1600, end=100, value=0.25):
    return {"type": "audio", "sequence": sequence, "sampleEndMs": end,
            "pcm": base64.b64encode(struct.pack("<f", value) * count).decode("ascii")}


class FakeStream:
    def __init__(self):
        self.accepted = []
        self.pending = 0
        self.text = ""
        self.finished = 0
        self.endpoint = False

    def accept_waveform(self, rate, samples):
        if self.finished:
            raise AssertionError("accepted audio after input_finished")
        if rate != 16000:
            raise AssertionError("wrong recognizer sample rate")
        self.accepted.append(list(samples))
        self.pending += 1

    def input_finished(self):
        self.finished += 1


class FakeRecognizer:
    """Only replaces native inference; wrapper validation and state remain real."""
    def __init__(self, results=(), endpoints=()):
        self.results = iter(results)
        self.endpoints = iter(endpoints)
        self.streams = []
        self.result_reads = 0
        self.decode_calls = 0
        self.reset_calls = 0

    def create_stream(self):
        stream = FakeStream()
        self.streams.append(stream)
        return stream

    def is_ready(self, stream):
        return stream.pending > 0

    def decode_stream(self, stream):
        stream.pending -= 1
        self.decode_calls += 1
        stream.text = next(self.results, stream.text)
        stream.endpoint = next(self.endpoints, False)

    def get_result(self, stream):
        self.result_reads += 1
        return stream.text

    def is_endpoint(self, stream):
        return stream.endpoint

    def reset(self, stream):
        self.reset_calls += 1
        stream.text = ""
        stream.endpoint = False


class OnlineTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(online, "online.py stateful adapter is not implemented")

    def adapter(self, results=(), endpoints=()):
        recognizer = FakeRecognizer(results, endpoints)
        adapter = online.OnlineAdapter(recognizer)
        self.assertEqual(adapter.handle({"type": "start", "sampleRate": 16000}),
                         [{"type": "started"}])
        return adapter, recognizer

    def test_each_pcm_sample_is_accepted_once_and_partial_only_changes(self):
        adapter, recognizer = self.adapter(["ONE", "ONE", "ONE TWO"])
        events = []
        for seq in range(3):
            events += adapter.handle(audio(seq, end=(seq + 1) * 100))
        self.assertEqual([(e["sequence"], e["text"]) for e in events],
                         [(0, "ONE"), (2, "ONE TWO")])
        self.assertEqual([len(x) for x in recognizer.streams[0].accepted], [1600] * 3)
        self.assertEqual(recognizer.result_reads, recognizer.decode_calls)
        self.assertEqual(events[-1]["sampleEndMs"], 300)
        self.assertEqual(events[-1].get("segmentStartMs"), 0)

    def test_finish_drains_once_and_keeps_real_sample_time(self):
        adapter, recognizer = self.adapter(["ONE", "ONE TWO"])
        adapter.handle(audio())
        events = adapter.handle({"type": "finish"})
        self.assertEqual(events[-1]["type"], "complete")
        self.assertEqual(events[-1]["text"], "ONE TWO")
        self.assertEqual(events[-1]["sampleEndMs"], 100)
        self.assertEqual(events[-1]["syntheticPaddingSamples"], 10560)
        self.assertEqual(recognizer.streams[0].finished, 1)
        self.assertEqual([len(x) for x in recognizer.streams[0].accepted], [1600, 10560])
        self.assertEqual(set(recognizer.streams[0].accepted[-1]), {0.0})
        self.assertEqual(adapter.handle({"type": "finish"}), [])
        self.assertEqual(recognizer.streams[0].finished, 1)

    def test_endpoint_segments_are_all_in_complete_and_new_text_is_not_deduplicated(self):
        adapter, recognizer = self.adapter(["ONE", "ONE", "TWO", "TWO"], [True, True])
        first = adapter.handle(audio())
        second = adapter.handle(audio(1, end=200))
        third = adapter.handle(audio(2, end=300))
        complete = adapter.handle({"type": "finish"})[-1]
        self.assertEqual(first[-1]["reason"], "acoustic")
        self.assertEqual(second[-1]["segment"], 1)
        self.assertEqual(third[0]["segment"], 2)
        self.assertEqual(third[0].get("segmentStartMs"), 200)
        self.assertEqual(complete["text"], "ONE ONE TWO")
        self.assertEqual(recognizer.reset_calls, 2)

    def test_hard_limit_splits_input_at_exact_twelve_seconds_without_loss(self):
        adapter, recognizer = self.adapter(["FIRST", "FIRST END", "SECOND", "SECOND END"])
        events = adapter.handle(audio(count=192000, end=12000))
        self.assertEqual(events[-1]["type"], "endpoint")
        self.assertEqual(events[-1]["reason"], "hard_limit")
        self.assertEqual(events[-1]["sampleEndMs"], 12000)
        adapter.handle(audio(1, count=1600, end=12100))
        complete = adapter.handle({"type": "finish"})[-1]
        self.assertEqual(complete["text"], "FIRST END SECOND END")
        self.assertEqual([len(x) for x in recognizer.streams[0].accepted], [192000, 10560])
        self.assertEqual([len(x) for x in recognizer.streams[1].accepted], [1600, 10560])

    def test_audio_chunk_crossing_limit_is_split_before_inference(self):
        adapter, recognizer = self.adapter()
        adapter.handle(audio(count=191200, end=11950))
        events = adapter.handle(audio(1, count=1600, end=12050))
        self.assertEqual(events[-1]["sampleEndMs"], 12000)
        self.assertEqual([len(x) for x in recognizer.streams[0].accepted], [191200, 800, 10560])
        self.assertEqual([len(x) for x in recognizer.streams[1].accepted], [800])

    def test_cancel_discards_pending_session_and_allows_fresh_start(self):
        adapter, recognizer = self.adapter(["OLD", "NEW", "NEW END"])
        adapter.handle(audio())
        self.assertEqual(adapter.handle({"type": "cancel"}), [{"type": "cancelled"}])
        self.assertEqual(adapter.handle({"type": "finish"}), [])
        with self.assertRaises(ValueError):
            adapter.handle(audio(1, end=200))
        adapter.handle({"type": "start", "sampleRate": 16000})
        events = adapter.handle(audio()) + adapter.handle({"type": "finish"})
        self.assertEqual(events[-1]["text"], "NEW END")
        self.assertEqual(events[-1]["sequence"], 0)
        self.assertEqual(recognizer.streams[0].finished, 0)

    def test_start_after_finish_creates_new_stream_and_empty_finish_is_valid(self):
        adapter, recognizer = self.adapter()
        complete = adapter.handle({"type": "finish"})[-1]
        self.assertEqual(complete["text"], "")
        self.assertEqual(complete["sampleEndMs"], 0)
        self.assertEqual(complete["sequence"], -1)
        adapter.handle({"type": "start", "sampleRate": 16000})
        adapter.handle(audio())
        self.assertEqual(len(recognizer.streams), 2)

    def test_rejects_duplicate_start_and_non_16khz(self):
        adapter, _ = self.adapter()
        with self.assertRaises(ValueError):
            adapter.handle({"type": "start", "sampleRate": 16000})
        adapter.handle({"type": "cancel"})
        for rate in [8000, 16000.0, True, "16000"]:
            with self.subTest(rate=rate), self.assertRaises(ValueError):
                adapter.handle({"type": "start", "sampleRate": rate})

    def test_sequence_must_start_at_zero_and_be_contiguous_integer(self):
        adapter, recognizer = self.adapter()
        for sequence in [1, -1, True, 0.0, "0"]:
            with self.subTest(sequence=sequence), self.assertRaises(ValueError):
                adapter.handle(audio(sequence))
        self.assertEqual(recognizer.streams[0].accepted, [])
        adapter.handle(audio())
        for sequence in [0, 2]:
            with self.subTest(sequence=sequence), self.assertRaises(ValueError):
                adapter.handle(audio(sequence, end=200))
        adapter.handle(audio(1, end=200))
        self.assertEqual(sum(map(len, recognizer.streams[0].accepted)), 3200)

    def test_invalid_pcm_or_time_does_not_advance_sequence_or_accept_samples(self):
        adapter, recognizer = self.adapter()
        invalid = [
            {**audio(), "pcm": "!!!"}, {**audio(), "pcm": ""},
            {**audio(), "pcm": base64.b64encode(b"abc").decode()},
            audio(value=float("nan")), audio(value=float("inf")),
            audio(value=1.1), audio(end=99), audio(end=float("inf")),
            audio(end=True), audio(end="100"),
        ]
        for message in invalid:
            with self.subTest(message={k: v for k, v in message.items() if k != "pcm"}):
                with self.assertRaises(ValueError):
                    adapter.handle(message)
        self.assertEqual(recognizer.streams[0].accepted, [])
        adapter.handle(audio())
        self.assertEqual(sum(map(len, recognizer.streams[0].accepted)), 1600)

    def test_protocol_rejects_unknown_or_non_object_commands(self):
        adapter, _ = self.adapter()
        for message in [None, [], "audio", {"type": "other"}, {}]:
            with self.subTest(message=message), self.assertRaises(ValueError):
                adapter.handle(message)

    def test_factory_loads_only_fixed_fp32_files_and_explicit_endpoint_settings(self):
        arguments = []
        native = SimpleNamespace(OnlineRecognizer=SimpleNamespace(
            from_transducer=lambda **kwargs: arguments.append(kwargs) or "recognizer"))
        with tempfile.TemporaryDirectory() as directory:
            candidate = json.loads(PATH.with_name("candidate.json").read_text())
            files = candidate["weights"]["files"]
            for entry in files:
                (Path(directory) / entry["name"]).touch()
            self.assertEqual(set(online.MODEL_FILES.values()), {entry["name"] for entry in files})
            with patch.dict(sys.modules, {"sherpa_onnx": native}):
                self.assertEqual(online.create_recognizer(directory), "recognizer")
            self.assertEqual(arguments[0]["model_type"], candidate["recognizer"]["model_type"])
            self.assertEqual(arguments[0]["provider"], "cpu")
            self.assertEqual(arguments[0]["num_threads"], 2)
            self.assertEqual(arguments[0]["decoding_method"], "greedy_search")
            self.assertTrue(arguments[0]["enable_endpoint_detection"])
            self.assertEqual(arguments[0]["rule1_min_trailing_silence"], 2.4)
            self.assertEqual(arguments[0]["rule2_min_trailing_silence"], 1.2)
            self.assertEqual(arguments[0]["rule3_min_utterance_length"], 20.0)
            (Path(directory) / "tokens.txt").unlink()
            with self.assertRaises(ValueError):
                online.create_recognizer(directory)

    def test_json_lines_driver_emits_ready_and_fails_closed_on_invalid_input(self):
        recognizer = FakeRecognizer(["ONE", "ONE TWO"])
        incoming = io.StringIO("\n".join(json.dumps(x) for x in [
            {"type": "start", "sampleRate": 16000}, audio(), {"type": "finish"}]) + "\n")
        output, errors = io.StringIO(), io.StringIO()
        code = online.serve(recognizer, incoming, output, errors)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(code, 0)
        self.assertEqual(events[0], {"type": "ready"})
        self.assertEqual(events[1], {"type": "started"})
        self.assertEqual(events[-1]["text"], "ONE TWO")
        self.assertEqual(errors.getvalue(), "")
        output, errors = io.StringIO(), io.StringIO()
        code = online.serve(FakeRecognizer(), io.StringIO("{bad json}\n"), output, errors)
        self.assertEqual(code, 2)
        self.assertEqual(output.getvalue().splitlines(), ['{"type":"ready"}'])
        self.assertIn("line 1", errors.getvalue())


if __name__ == "__main__":
    unittest.main()
