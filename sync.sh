#!/usr/bin/env bash
# sync.sh — copy local machine config into this repo, commit, and push.
#
# Each ENTRIES line is "<type>:<source>:<repo-relative dest>"
#   copy:<file path>:<dest>   copy a local file into the repo
#   cmd:<command>:<dest>      run a command and write stdout to <dest>
# Add a line to sync more; only the listed dests are committed.
#
# Usage: ./sync.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

ENTRIES=(
  "copy:$HOME/.config/cmux/cmux.json:cmux.json"

  # Uncomment to also sync VS Code (overwrites the repo copies with your live ones):
  # "copy:$HOME/Library/Application Support/Code/User/settings.json:vscode-settings.json"
  # "cmd:code --list-extensions:vscode-extensions.txt"
)

dests=()
for entry in "${ENTRIES[@]}"; do
  type="${entry%%:*}"
  rest="${entry#*:}"
  src="${rest%:*}"
  dest="${rest##*:}"
  mkdir -p "$(dirname "$dest")"
  case "$type" in
    copy)
      if [ ! -f "$src" ]; then echo "skip (missing source): $src"; continue; fi
      cp "$src" "$dest" ;;
    cmd)
      if ! ( eval "$src" ) > "$dest.tmp" 2>/dev/null; then
        echo "skip (command failed): $src"; rm -f "$dest.tmp"; continue
      fi
      mv "$dest.tmp" "$dest" ;;
    *)
      echo "skip (unknown type '$type'): $entry"; continue ;;
  esac
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
