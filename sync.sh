#!/usr/bin/env bash
# sync.sh — mirror local machine config into this repo, commit, and push.
#
# HOME_FILES: files under $HOME, copied to the SAME relative path in the repo
#   (e.g. ~/.config/cmux/cmux.json -> .config/cmux/cmux.json).
# GENERATED:  "<command>::<repo-relative dest>" — command stdout written to dest.
# Only the resulting paths are staged; unrelated changes are left alone.
#
# Usage: ./sync.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

HOME_FILES=(
  "$HOME/.config/cmux/cmux.json"
)

GENERATED=(
  # "code --list-extensions::vscode-extensions.txt"
)

dests=()

for src in "${HOME_FILES[@]}"; do
  case "$src" in
    "$HOME"/*) dest="${src#"$HOME"/}" ;;
    *) echo "skip (not under \$HOME): $src"; continue ;;
  esac
  if [ ! -f "$src" ]; then echo "skip (missing): $src"; continue; fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  dests+=("$dest")
  echo "synced: $dest"
done

for entry in "${GENERATED[@]}"; do
  cmd="${entry%::*}"
  dest="${entry##*::}"
  mkdir -p "$(dirname "$dest")"
  if ! ( eval "$cmd" ) > "$dest.tmp" 2>/dev/null; then
    echo "skip (command failed): $cmd"; rm -f "$dest.tmp"; continue
  fi
  mv "$dest.tmp" "$dest"
  dests+=("$dest")
  echo "synced: $dest"
done

if [ ${#dests[@]} -eq 0 ]; then echo "Nothing synced."; exit 0; fi

git add -- "${dests[@]}"
if git diff --cached --quiet; then
  echo "No changes; nothing to commit."
  exit 0
fi

git commit -m "chore: sync config ($(date '+%Y-%m-%d %H:%M'))"
git push
echo "Pushed to $(git remote get-url origin)"
