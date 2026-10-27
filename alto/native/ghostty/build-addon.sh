#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd "$(dirname "$0")" && pwd)
vendor_root="$script_dir/vendor"
build_output="$script_dir/build"
ghostty_headers=$(find "$vendor_root/GhosttyKit.xcframework" -type d -name Headers -print -quit)
node_headers=$(node -p 'require("node:path").resolve(require("node:path").dirname(process.execPath), "../include/node")')
mkdir -p "$build_output"
addon_temporary=$(mktemp "$build_output/ghostty-terminal.XXXXXX.node")
archive_directory=$(mktemp -d /tmp/alto-ghostty-archives.XXXXXX)
trap 'rm -f "$addon_temporary"; rm -rf "$archive_directory"' EXIT
# Repack Zig's archives with Apple's libtool: recent Xcode no longer includes
# ld_classic, and its linker requires eight-byte-aligned Mach-O members.
repack_archive() {
  local source="$1" name
  name=$(basename "$source")
  mkdir -p "$archive_directory/$name.objects"
  (cd "$archive_directory/$name.objects" && /usr/bin/ar -x "$source")
  chmod u+r "$archive_directory/$name.objects/"*.o
  xcrun libtool -static -no_warning_for_no_symbols \
    -o "$archive_directory/$name" "$archive_directory/$name.objects/"*.o
}
repack_archive "$vendor_root/libghostty-core.a"
for archive in "$vendor_root/lib/"*.a; do repack_archive "$archive"; done

ghostty_dependencies=(
  "$archive_directory/libfreetype.a"
  "$archive_directory/libpng.a"
  "$archive_directory/libz.a"
  "$archive_directory/liboniguruma.a"
  "$archive_directory/libglslang.a"
  "$archive_directory/libspirv_cross.a"
  "$archive_directory/libsentry.a"
  "$archive_directory/libsimdutf.a"
  "$archive_directory/libhighway.a"
  "$archive_directory/libutfcpp.a"
  "$archive_directory/libmacos.a"
  "$archive_directory/libintl.a"
  "$archive_directory/libdcimgui.a"
  "$archive_directory/libbreakpad.a"
)

xcrun clang++ \
  -std=c++20 \
  -fobjc-arc \
  -bundle \
  -undefined dynamic_lookup \
  -DNODE_GYP_MODULE_NAME=ghostty_terminal \
  -I"$node_headers" \
  -I"$ghostty_headers" \
  "$script_dir/ghostty-terminal.mm" \
  -Wl,-force_load,"$archive_directory/libghostty-core.a" \
  "${ghostty_dependencies[@]}" \
  -framework AppKit \
  -framework Carbon \
  -framework CoreFoundation \
  -framework CoreGraphics \
  -framework CoreText \
  -framework CoreVideo \
  -framework Foundation \
  -framework IOSurface \
  -framework Metal \
  -framework QuartzCore \
  -framework UniformTypeIdentifiers \
  -framework UserNotifications \
  -o "$addon_temporary"

if ! nm -gU "$addon_temporary" | grep ' _ghostty_init$' >/dev/null; then
  echo "The rebuilt bridge is missing the Ghostty renderer." >&2
  exit 1
fi
mv "$addon_temporary" "$build_output/ghostty-terminal.node"

echo "Built $build_output/ghostty-terminal.node"
