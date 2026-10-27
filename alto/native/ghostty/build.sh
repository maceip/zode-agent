#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
project_root=$(cd "$script_dir/../.." && pwd)
ghostty_version=1.3.1
zig_version=0.15.2
build_root=$(mktemp -d /tmp/alto-ghostty.XXXXXX)
download_cache="$script_dir/.cache"
cleanup() {
  if [[ "${CODEX_GHOSTTY_KEEP_BUILD:-0}" == 1 ]]; then
    echo "Preserved Ghostty build directory at $build_root"
    return
  fi
  rm -rf "$build_root"
}
trap cleanup EXIT

case "$(uname -m)" in
  arm64) zig_arch=aarch64 ;;
  x86_64) zig_arch=x86_64 ;;
  *) echo "Ghostty native support only builds on macOS arm64 or x86_64." >&2; exit 1 ;;
esac

if xcodebuild -showComponent MetalToolchain 2>&1 | grep -q 'Status: uninstalled'; then
  xcodebuild -downloadComponent MetalToolchain
fi

zig_root="$build_root/zig"
ghostty_root="$build_root/ghostty"
mkdir -p "$zig_root" "$ghostty_root" "$download_cache"

zig_archive="$download_cache/zig-$zig_arch-macos-$zig_version.tar.xz"
ghostty_archive="$download_cache/ghostty-source-$ghostty_version.tar.gz"
if [[ ! -s "$zig_archive" ]]; then
  curl -fL --remove-on-error \
    "https://ziglang.org/download/$zig_version/zig-$zig_arch-macos-$zig_version.tar.xz" \
    -o "$zig_archive.part"
  mv "$zig_archive.part" "$zig_archive"
fi
if [[ ! -s "$ghostty_archive" ]]; then
  curl -fL --remove-on-error \
    "https://release.files.ghostty.org/$ghostty_version/ghostty-source.tar.gz" \
    -o "$ghostty_archive.part"
  mv "$ghostty_archive.part" "$ghostty_archive"
fi
tar -xJf "$zig_archive" --strip-components=1 -C "$zig_root"
tar -xzf "$ghostty_archive" --strip-components=1 -C "$ghostty_root"

# Embedded terminals should open at the prompt. Ghostty normally prints the
# macOS login banner unless the user happens to have ~/.hushlogin; make this
# private build consistently pass login(1)'s quiet flag instead.
grep -q 'if (hush) try args.append(alloc, "-q");' "$ghostty_root/src/termio/Exec.zig"
perl -0pi -e 's/if \(hush\) try args\.append\(alloc, "-q"\);/_ = hush;\n        try args.append(alloc, "-q");/' \
  "$ghostty_root/src/termio/Exec.zig"

# Ghostty asks before terminal-initiated reads but allows OSC 52 writes by
# default. Alto has no native clipboard approval sheet yet, so make both
# directions request confirmation. Explicit user configuration can still opt
# into allow or deny, and the bridge below honors that policy signal.
grep -q '@"clipboard-write": ClipboardAccess = .allow,' "$ghostty_root/src/config/Config.zig"
perl -0pi -e 's/@"clipboard-write": ClipboardAccess = \.allow,/@"clipboard-write": ClipboardAccess = .ask,/' \
  "$ghostty_root/src/config/Config.zig"

# Zig 0.15.2 cannot parse the macOS 26.5 libSystem stub. Point it at the
# current SDK headers/frameworks with Zig's bundled, parseable libSystem stub.
sdk=$(cd "$(xcrun --sdk macosx --show-sdk-path)" && pwd -P)
sdk_overlay="$build_root/sdk-overlay"
mkdir -p "$sdk_overlay/usr/lib" "$sdk_overlay/usr/include"
find "$sdk" -mindepth 1 -maxdepth 1 ! -name usr -exec ln -s {} "$sdk_overlay/" \;
find "$sdk/usr" -mindepth 1 -maxdepth 1 ! -name lib ! -name include \
  -exec ln -s {} "$sdk_overlay/usr/" \;
find "$sdk/usr/include" -mindepth 1 -maxdepth 1 ! -name math.h \
  -exec ln -s {} "$sdk_overlay/usr/include/" \;
find "$sdk/usr/lib" -mindepth 1 -maxdepth 1 \
  ! -name libSystem.tbd ! -name libSystem.B.tbd \
  -exec ln -s {} "$sdk_overlay/usr/lib/" \;
cp "$zig_root/lib/libc/darwin/libSystem.tbd" "$sdk_overlay/usr/lib/libSystem.B.tbd"
ln -s libSystem.B.tbd "$sdk_overlay/usr/lib/libSystem.tbd"

# Xcode 27 delegates these macros to newer Clang resource headers than the
# pinned Zig provides. Supply the missing definitions in our temporary SDK
# overlay, following Ghostty's upstream apple-sdk compatibility header.
cat > "$sdk_overlay/usr/include/math.h" <<EOF
#pragma once
#include "$sdk/usr/include/math.h"
#ifndef INFINITY
#define INFINITY (__builtin_inff())
#endif
#ifndef NAN
#define NAN (__builtin_nanf(""))
#endif
EOF

perl -0pi -e 's/pub fn getSdk\(allocator: Allocator, target: \*const Target\) \?\[\]const u8 \{/pub fn getSdk(allocator: Allocator, target: *const Target) ?[]const u8 {\n    if (std.process.getEnvVarOwned(allocator, "SDKROOT")) |sdk_root| {\n        return sdk_root;\n    } else |_| {}\n/' \
  "$zig_root/lib/std/zig/system/darwin.zig"

developer_dir=$(xcode-select --print-path)
CODEX_GHOSTTY_DEVELOPER_DIR="$developer_dir" perl -0pi -e 's/(run_ir\.addArgs)/run_ir.setEnvironmentVariable("DEVELOPER_DIR", "$ENV{"CODEX_GHOSTTY_DEVELOPER_DIR"}");\n    $1/; s/(run_lib\.addArgs)/run_lib.setEnvironmentVariable("DEVELOPER_DIR", "$ENV{"CODEX_GHOSTTY_DEVELOPER_DIR"}");\n    $1/' \
  "$ghostty_root/src/build/MetallibStep.zig"
CODEX_GHOSTTY_DEVELOPER_DIR="$developer_dir" perl -0pi -e 's/(run\.has_side_effects = true;)/$1\n        run.setEnvironmentVariable("DEVELOPER_DIR", "$ENV{"CODEX_GHOSTTY_DEVELOPER_DIR"}");/g' \
  "$ghostty_root/src/build/XCFrameworkStep.zig"
CODEX_GHOSTTY_DEVELOPER_DIR="$developer_dir" perl -0pi -e 's/(run_step\.addArgs)/run_step.setEnvironmentVariable("DEVELOPER_DIR", "$ENV{"CODEX_GHOSTTY_DEVELOPER_DIR"}");\n    $1/' \
  "$ghostty_root/src/build/LibtoolStep.zig"

(
  cd "$ghostty_root"
  DEVELOPER_DIR=/nonexistent \
  SDKROOT="$sdk_overlay" \
    "$zig_root/zig" build \
      -Doptimize=ReleaseFast \
      -Dapp-runtime=none \
      -Demit-macos-app=false \
      -Demit-terminfo=true \
      -Demit-xcframework=true \
      -Dxcframework-target=native
)

vendor_root="$script_dir/vendor"
build_output="$script_dir/build"
rm -rf "$vendor_root" "$build_output"
mkdir -p "$vendor_root/lib" "$vendor_root/share" "$build_output"
cp -R "$ghostty_root/macos/GhosttyKit.xcframework" "$vendor_root/"
cp -R "$ghostty_root/zig-out/share/ghostty" "$vendor_root/share/"
cp -R "$ghostty_root/zig-out/share/terminfo" "$vendor_root/share/"

ghostty_headers=$(find "$vendor_root/GhosttyKit.xcframework" -type d -name Headers -print -quit)
ghostty_core=
while IFS= read -r candidate; do
  # Do not use grep -q here. With pipefail enabled it closes the pipe as soon as
  # it sees the symbol, which makes nm exit on SIGPIPE and rejects the archive.
  if nm -gU "$candidate" 2>/dev/null | grep ' _ghostty_init$' >/dev/null; then
    ghostty_core="$candidate"
    break
  fi
done < <(find "$ghostty_root/.zig-cache" -type f -name libghostty.a -print)
node_headers=$(node -p 'require("node:path").resolve(require("node:path").dirname(process.execPath), "../include/node")')

if [[ -z "$ghostty_core" || -z "$ghostty_headers" || ! -f "$node_headers/node_api.h" ]]; then
  echo "Could not locate the Ghostty archives or Node N-API headers." >&2
  exit 1
fi
cp "$ghostty_core" "$vendor_root/libghostty-core.a"

dependency_names=(
  libfreetype.a
  libpng.a
  libz.a
  liboniguruma.a
  libglslang.a
  libspirv_cross.a
  libsentry.a
  libsimdutf.a
  libhighway.a
  libutfcpp.a
  libmacos.a
  libintl.a
  libdcimgui.a
  libbreakpad.a
)
for name in "${dependency_names[@]}"; do
  candidate=$(find "$ghostty_root/.zig-cache" -type f -name "$name" -print -quit)
  if [[ -z "$candidate" ]]; then
    echo "Could not locate Ghostty dependency $name." >&2
    exit 1
  fi
  cp "$candidate" "$vendor_root/lib/$name"
done

# Compile the bridge separately so native fixes do not rebuild Ghostty.
bash "$script_dir/build-addon.sh"
