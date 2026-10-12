#!/bin/sh
# Project-local macOS build. Requires git, Apple command-line tools and CMake.
set -eu
TASK_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$TASK_ROOT"
CMAKE_BIN=${CMAKE_BIN:-"$TASK_ROOT/work/local-runtime/venv/bin/cmake"}
if [ ! -x "$CMAKE_BIN" ]; then
  echo 'Set CMAKE_BIN to an installed CMake executable.' >&2
  exit 1
fi
mkdir -p work/local-runtime
checkout() {
  name=$1
  revision=$2
  if [ ! -d "work/local-runtime/$name/.git" ]; then
    git clone --no-checkout "https://github.com/ggml-org/$name.git" "work/local-runtime/$name"
    git -C "work/local-runtime/$name" checkout --detach "$revision"
  fi
  actual=$(git -C "work/local-runtime/$name" rev-parse HEAD)
  if [ "$actual" != "$revision" ]; then
    echo "Unexpected $name revision; preserving existing checkout." >&2
    exit 1
  fi
  if [ -n "$(git -C "work/local-runtime/$name" status --porcelain --untracked-files=no)" ]; then
    echo "Modified $name checkout; preserving local changes." >&2
    exit 1
  fi
}
checkout whisper.cpp d1be6fde11ac6e0407606b4e42fe72d34add8037
checkout llama.cpp 3d65c90d04d337e88f2b1f7f0061f40a5324e662
"$CMAKE_BIN" -S work/local-runtime/whisper.cpp -B work/local-runtime/whisper.cpp/build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=ON -DWHISPER_SDL2=OFF -DGGML_METAL=ON
"$CMAKE_BIN" --build work/local-runtime/whisper.cpp/build --target whisper-server whisper-cli -j 4
"$CMAKE_BIN" -S work/local-runtime/llama.cpp -B work/local-runtime/llama.cpp/build -DCMAKE_BUILD_TYPE=Release -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_BUILD_APP=OFF -DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF -DLLAMA_OPENSSL=OFF -DGGML_METAL=ON
"$CMAKE_BIN" --build work/local-runtime/llama.cpp/build --target llama-server -j 4
