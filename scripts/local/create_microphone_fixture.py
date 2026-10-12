"""Join existing synthetic samples for a deterministic fake-microphone E2E test."""
from pathlib import Path
import wave
ROOT = Path(__file__).resolve().parents[2]
out = ROOT / 'work/local-runtime/microphone-fixture.wav'
out.parent.mkdir(parents=True, exist_ok=True)
frames = b'\0' * 16000 * 2 * 2
for name in ['numbers', 'long']:
    with wave.open(str(ROOT / 'tests/fixtures/local' / (name + '.wav')), 'rb') as source:
        assert source.getnchannels() == 1 and source.getframerate() == 16000 and source.getsampwidth() == 2
        frames += source.readframes(source.getnframes())
    frames += b'\0' * 16000 * 2 * 2
frames += b'\0' * 16000 * 2 * 8
with wave.open(str(out), 'wb') as target:
    target.setnchannels(1)
    target.setsampwidth(2)
    target.setframerate(16000)
    target.writeframes(frames)
print(out)
