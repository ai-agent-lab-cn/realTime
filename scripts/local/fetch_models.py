"""Download pinned evaluation models with resumable transfers and SHA-256 checks."""
import concurrent.futures
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODELS = [
    {"repo": "ggml-org/whisper-vad", "revision": "9ffd54a1e1ee413ddf265af9913beaf518d1639b", "file": "ggml-silero-v5.1.2.bin", "size": 885098, "sha256": "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf"},
    {"repo": "ggerganov/whisper.cpp", "revision": "5359861c739e955e79d9a303bcbc70fb988958b1", "file": "ggml-small.bin", "size": 487601967, "sha256": "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b"},
    {"repo": "lmstudio-community/Qwen3-4B-Instruct-2507-GGUF", "revision": "4edb920b6f14e3b9284d4502a6485103d72cde05", "file": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf", "size": 2497280448, "sha256": "8cdb57cbb880d313736a9bc4e3d3d2485f145b5e19cf33783746e753e82641fc"},
]

def digest(path):
    sha = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            sha.update(block)
    return sha.hexdigest()

def fetch(model):
    directory = ROOT / 'models'
    directory.mkdir(exist_ok=True)
    target = directory / model['file']
    partial = directory / (model['file'] + '.part')
    url = f"https://huggingface.co/{model['repo']}/resolve/{model['revision']}/{model['file']}"
    if target.exists():
        if target.stat().st_size != model['size'] or digest(target) != model['sha256']:
            raise RuntimeError(f'Existing model failed integrity check: {target.name}')
        print(f'{target.name}: already verified', flush=True)
        return
    # Preserve the contiguous prefix, fetch independent byte ranges, then append in order.
    offset = partial.stat().st_size if partial.exists() else 0
    chunks = ROOT / 'work/local-runtime/chunks' / model['file']
    chunks.mkdir(parents=True, exist_ok=True)
    step = 16 * 1024 * 1024
    ranges = [(start, min(start + step, model['size']) - 1) for start in range(offset, model['size'], step)]
    def part(bounds):
        start, end = bounds
        path = chunks / f'{start}-{end}'
        if path.exists() and path.stat().st_size == end-start+1:
            return path
        for attempt in range(8):
            result = subprocess.run(['curl','--fail','--location','--silent','--show-error','--connect-timeout','15','--max-time','55','--range',f'{start}-{end}','--output',str(path),url + f'?range={start}'],capture_output=True,text=True)
            if result.returncode == 0 and path.stat().st_size == end-start+1:
                print(f"{target.name}: range {start}-{end} complete",flush=True)
                return path
        raise RuntimeError(f'Failed range {start}-{end}: {result.stderr[-200:]}')
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        pieces=list(pool.map(part,ranges))
    with partial.open('ab') as output:
        for path in pieces:
            with path.open('rb') as handle:
                for block in iter(lambda:handle.read(8*1024*1024),b''):
                    output.write(block)
    for path in pieces:
        path.unlink()
    if not partial.exists() or partial.stat().st_size != model['size'] or digest(partial) != model['sha256']:
        raise RuntimeError(f'Incomplete download or checksum mismatch: {target.name}')
    partial.rename(target)
    print(f'{target.name}: SHA-256 verified', flush=True)

if __name__ == '__main__':
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(fetch, MODELS))
    (ROOT / 'models' / 'manifest.json').write_text(json.dumps(MODELS, ensure_ascii=False, indent=2))
