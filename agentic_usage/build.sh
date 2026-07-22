#!/usr/bin/env bash
# Build, merge and package the Agentic Usage dashboard app.
#
# Builds each cu_* visualization from examples/, copies the bundled assets into
# this parent app, rewrites the property namespace ({viz}.{viz} -> agentic_usage.{viz}),
# merges conf files, prepends embedded fonts, bumps the version, and packages
# dist/agentic_usage.tar.gz.
#
# Usage: ./agentic_usage/build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXAMPLES_DIR="$REPO_ROOT/examples"
TARGET_APP="$SCRIPT_DIR"
APP_NAME="agentic_usage"
FONT_CSS="$REPO_ROOT/shared/agentic_usage_fonts.css"
THEME_CSS="$REPO_ROOT/shared/agentic_usage_theme.css"

APPS=( cu_kpi cu_leaderboard cu_stat cu_area cu_donut cu_heatmap cu_feed cu_bars cu_sessions cu_ticker cu_checklist )

# Dashboards in nav order: view name / rail icon
DASHBOARDS=(
    "agentic_overview chartpanels"
    "agentic_sessions pulse"
    "agentic_health health"
)

# --- Parse args -------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1 (see --help)"; exit 1 ;;
    esac
done

# Regenerate nav/default.xml from the DASHBOARDS registry
write_nav() {
    local nav="$TARGET_APP/default/data/ui/nav/default.xml"
    local entry view icon attrs
    {
        echo "<nav>"
        for entry in "${DASHBOARDS[@]}"; do
            read -r view icon <<< "$entry"
            attrs=""
            [ "$view" == "agentic_overview" ] && attrs=' default="true"'
            echo "  <view name=\"$view\"$attrs icon=\"$icon\" />"
        done
        echo "</nav>"
    } > "$nav"
}

echo "=== Agentic Usage — build ==="

# Reset merged conf files + stale assets
: > "$TARGET_APP/default/visualizations.conf"
: > "$TARGET_APP/default/savedsearches.conf"
mkdir -p "$TARGET_APP/README"
: > "$TARGET_APP/README/savedsearches.conf.spec"
rm -rf "$TARGET_APP/appserver"
# Trim metadata back to the global block (drop stale per-viz export stanzas)
awk '/^\[visualizations\//{exit} {print}' "$TARGET_APP/metadata/default.meta" > "$TARGET_APP/metadata/default.meta.tmp"
mv "$TARGET_APP/metadata/default.meta.tmp" "$TARGET_APP/metadata/default.meta"

build_viz() {
    local v="$1"
    local dir="$EXAMPLES_DIR/$v/appserver/static/visualizations/$v"
    [ -d "$dir" ] || { echo "  x $v (not found)"; return 1; }
    if [ ! -d "$dir/node_modules" ]; then ( cd "$dir" && npm install --silent ); fi
    ( cd "$dir" && npm run build --silent )
    [ -f "$dir/visualization.js" ] || { echo "  x $v (build failed)"; return 1; }
    echo "  + built $v"
}

merge_viz() {
    local v="$1"
    local src_app="$EXAMPLES_DIR/$v"
    local src_viz="$src_app/appserver/static/visualizations/$v"
    local dest="$TARGET_APP/appserver/static/visualizations/$v"
    mkdir -p "$dest"
    shopt -s nullglob
    local f fn
    for f in "$src_viz"/*.js "$src_viz"/*.css "$src_viz"/*.html "$src_viz"/*.png "$src_viz"/*.svg; do
        fn="$(basename "$f")"
        case "$fn" in package.json|package-lock.json|webpack.config.js|harness.json) continue ;; esac
        cp "$f" "$dest/"
    done
    # Prepend embedded fonts to the viz CSS (once)
    local css="$dest/visualization.css"
    if [ -f "$FONT_CSS" ] && [ -f "$css" ] && ! grep -q "@font-face" "$css"; then
        cat "$FONT_CSS" "$css" > "$css.tmp" && mv "$css.tmp" "$css"
    fi
    # Prepend light-theme variable overrides to the viz CSS (once)
    if [ -f "$THEME_CSS" ] && [ -f "$css" ] && ! grep -q 'data-theme="light"' "$css"; then
        cat "$THEME_CSS" "$css" > "$css.tmp" && mv "$css.tmp" "$css"
    fi
    # Merge visualizations.conf (stanza name = viz, unchanged)
    { echo ""; cat "$src_app/default/visualizations.conf"; } >> "$TARGET_APP/default/visualizations.conf"
    # Merge savedsearches.conf with namespace rewrite {viz}.{viz} -> agentic_usage.{viz}
    if [ -f "$src_app/default/savedsearches.conf" ]; then
        sed "s/${v}\.${v}/${APP_NAME}.${v}/g" "$src_app/default/savedsearches.conf" >> "$TARGET_APP/default/savedsearches.conf"
        echo "" >> "$TARGET_APP/default/savedsearches.conf"
    fi
    # Merge spec with the same rewrite
    if [ -f "$src_app/README/savedsearches.conf.spec" ]; then
        sed "s/${v}\.${v}/${APP_NAME}.${v}/g" "$src_app/README/savedsearches.conf.spec" >> "$TARGET_APP/README/savedsearches.conf.spec"
        echo "" >> "$TARGET_APP/README/savedsearches.conf.spec"
    fi
    # metadata export stanza
    if ! grep -q "visualizations/$v" "$TARGET_APP/metadata/default.meta"; then
        { echo ""; echo "[visualizations/$v]"; echo "export = system"; } >> "$TARGET_APP/metadata/default.meta"
    fi
    echo "  + merged $v"
}

BUILT=()
echo "Building vizzes..."
for a in "${APPS[@]}"; do build_viz "$a" && BUILT+=("$a") || true; done
echo "Merging..."
for a in "${BUILT[@]}"; do merge_viz "$a"; done

# Collapse multiple blank lines in merged conf
for f in "$TARGET_APP/default/visualizations.conf" "$TARGET_APP/default/savedsearches.conf" "$TARGET_APP/README/savedsearches.conf.spec"; do
    [ -f "$f" ] && awk 'NF{blank=0;print;next}!blank++{print}' "$f" | sed '/./,$!d' > "$f.tmp" && mv "$f.tmp" "$f"
done

# Bump patch version (both [id] and [launcher])
CUR="$(grep '^version' "$TARGET_APP/default/app.conf" | head -1 | cut -d= -f2 | tr -d ' ')"
MAJ="$(echo "$CUR" | cut -d. -f1)"; MIN="$(echo "$CUR" | cut -d. -f2)"; PAT="$(echo "$CUR" | cut -d. -f3)"
NEW="${MAJ}.${MIN}.$((PAT + 1))"
if [[ "$(uname)" == "Darwin" ]]; then sed -i '' "s/^version = .*/version = ${NEW}/" "$TARGET_APP/default/app.conf"
else sed -i "s/^version = .*/version = ${NEW}/" "$TARGET_APP/default/app.conf"; fi
echo "  version: $CUR -> $NEW"

# Bump [install] build — Splunk keys its static-asset (viz JS/CSS) cache on this
# number, so without a bump the browser keeps serving stale visualization.js
# after an app upgrade. Increment it every build to force a re-fetch.
CURB="$(grep '^build = ' "$TARGET_APP/default/app.conf" | head -1 | cut -d= -f2 | tr -d ' ')"
NEWB="$((CURB + 1))"
if [[ "$(uname)" == "Darwin" ]]; then sed -i '' "s/^build = .*/build = ${NEWB}/" "$TARGET_APP/default/app.conf"
else sed -i "s/^build = .*/build = ${NEWB}/" "$TARGET_APP/default/app.conf"; fi
echo "  build: $CURB -> $NEWB"

# Regenerate nav deterministically from the registry, then package
write_nav

mkdir -p "$REPO_ROOT/dist"
TARBALL="$REPO_ROOT/dist/${APP_NAME}.tar.gz"
TAR_FLAGS=()
if [[ "$(uname)" == "Darwin" ]]; then
    xattr -rc "$TARGET_APP" 2>/dev/null || true
    export COPYFILE_DISABLE=1
    TAR_FLAGS+=(--disable-copyfile --no-xattrs --no-mac-metadata)
fi
tar ${TAR_FLAGS[@]+"${TAR_FLAGS[@]}"} \
    --exclude='.git' --exclude='.git*' --exclude='.DS_Store' --exclude='._*' --exclude='__MACOSX' \
    --exclude='local' --exclude='local.meta' --exclude='build.sh' \
    -czf "$TARBALL" -C "$REPO_ROOT" "$APP_NAME"

echo ""
echo "Done: $TARBALL"
echo "Install: Apps -> Manage Apps -> Install app from file"
