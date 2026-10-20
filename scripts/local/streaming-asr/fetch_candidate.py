#!/usr/bin/env python3
"""Fetch only the pinned fp32 experiment candidate; never touch other models."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[3]
MANIFEST = Path(__file__).with_name("candidate.json")
MODEL = ROOT / "models/sherpa-onnx-streaming-zipformer-en-2023-06-26"


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def verify(path, record):
    return path.is_file() and path.stat().st_size == record["bytes"] and digest(path) == record["sha256"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true", help="No network or writes; verify local artifacts")
    args = parser.parse_args()
    candidate = json.loads(MANIFEST.read_text())
    for record in candidate["weights"]["files"] + candidate["license"]["artifacts"]:
        path = ROOT / record["path"]
        if path.parent != MODEL or ".int8." in path.name:
            raise SystemExit("Refusing unexpected model destination or quantized artifact")
        if verify(path, record):
            print("verified", record["name"], record["sha256"], flush=True)
            continue
        if args.verify_only:
            raise SystemExit("Missing or incorrect artifact: " + record["name"])
        if path.exists():
            raise SystemExit("Refusing to overwrite an existing incorrect artifact: " + str(path))
        MODEL.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".part")
        print("downloading", record["name"], record["bytes"], flush=True)
        subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--connect-timeout", "30",
                        "--output", str(temporary), record["url"]], check=True)
        if not verify(temporary, record):
            raise SystemExit("Size or SHA-256 mismatch; retained .part: " + record["name"])
        temporary.rename(path)
        print("verified", record["name"], record["sha256"], flush=True)


if __name__ == "__main__":
    main()
