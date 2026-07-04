#!/usr/bin/env bash
input=$(cat)

j() { jq -r "$1 // empty" <<<"$input"; }

cwd=$(j '.workspace.current_dir // .cwd')
branch=$(j '.worktree.branch')
model=$(j '.model.display_name')
effort=$(j 'if (.effort|type)=="object" then .effort.level elif (.effort|type)=="string" then .effort else empty end')
[ -z "$effort" ] && effort=$(jq -r '.effortLevel // empty' "$HOME/.claude/settings.local.json" 2>/dev/null)
[ -z "$effort" ] && effort=$(jq -r '.effortLevel // empty' "$HOME/.claude/settings.json" 2>/dev/null)
used=$(j '.context_window.used_percentage')
five_hour=$(j '.rate_limits.five_hour.used_percentage')
five_hour_resets=$(j '.rate_limits.five_hour.resets_at')
seven_day=$(j '.rate_limits.seven_day.used_percentage')
seven_day_resets=$(j '.rate_limits.seven_day.resets_at')
lines_added=$(j '.cost.total_lines_added')
lines_removed=$(j '.cost.total_lines_removed')

# --- colors ---
RESET=$'\033[0m'
GREEN=$'\033[32m'
RED=$'\033[31m'
ORANGE=$'\033[38;5;208m'

pct() {
  local n c=$GREEN
  n=$(printf '%.0f' "$1")
  [ "$n" -ge 50 ] && c=$ORANGE
  [ "$n" -ge 80 ] && c=$RED
  printf '%s%s%%%s' "$c" "$n" "$RESET"
}

join() {
  local sep=$1; shift
  local out=""
  for p in "$@"; do
    [ -n "$out" ] && out+="$sep"
    out+="$p"
  done
  printf '%s' "$out"
}

# absolute day-time for an epoch: "3:20pm" today / "Tue 9am" this week / "Jul 12" later
fmt_when() {
  local ts=$1 out
  if [ "$(date -r "$now" +%Y%m%d)" = "$(date -r "$ts" +%Y%m%d)" ]; then
    out=$(date -r "$ts" +'%l:%M%p')          # same day → time only
  elif [ "$ts" -lt "$(( now + 604800 ))" ]; then
    out=$(date -r "$ts" +'%a %l:%M%p')       # within a week → weekday + time
  else
    out=$(date -r "$ts" +'%b %e')            # later → month day
  fi
  printf '%s' "$out" | sed -E 's/:00//g; s/AM/am/g; s/PM/pm/g; s/ +/ /g; s/^ //; s/ $//'
}

# compact dollars: $47.20 / $294 / $2.9k
fmt_money() {
  awk -v v="$1" 'BEGIN{
    if (v=="") exit
    if      (v>=1000) printf "$%.1fk", v/1000
    else if (v>=100)  printf "$%.0f", v
    else              printf "$%.2f", v
  }'
}

# weekly_retail_cached: echo the retail-$ value of the last 7 days of usage
# (rolling), computed by ccusage. Reads a ≤60s cache instantly and refreshes in
# the background so the status line never waits on log parsing.
weekly_retail_cached() {
  local dir="$HOME/.claude/.cache" file lock age val
  file="$dir/weekly_retail"; lock="$dir/weekly_retail.lock"
  mkdir -p "$dir" 2>/dev/null
  [ -f "$file" ] && val=$(cat "$file" 2>/dev/null)
  age=99999
  [ -f "$file" ] && age=$(( now - $(stat -f %m "$file" 2>/dev/null || echo 0) ))
  if [ "$age" -ge 60 ]; then
    if mkdir "$lock" 2>/dev/null; then          # atomic: only one refresh at a time
      (
        export PATH="$HOME/.bun/bin:$PATH"
        since=$(date -v-6d +%Y%m%d)             # today + 6 prior = rolling 7 days
        v=$(bunx ccusage daily --since "$since" --json 2>/dev/null \
              | jq -r '[(.daily // [])[].totalCost] | add // empty' 2>/dev/null)
        [ -n "$v" ] && printf '%s' "$v" > "$file"
        rmdir "$lock" 2>/dev/null
      ) >/dev/null 2>&1 &
      disown 2>/dev/null
    elif [ -d "$lock" ] && [ "$(( now - $(stat -f %m "$lock" 2>/dev/null || echo "$now") ))" -gt 180 ]; then
      rmdir "$lock" 2>/dev/null                 # clear a stale lock from a dead refresh
    fi
  fi
  printf '%s' "$val"
}

# daily24_retail_cached: echo retail-$ spend over the last 24h, from ccusage
# billing blocks (background-cached). Sums blocks whose start is within 24h.
daily24_retail_cached() {
  local dir="$HOME/.claude/.cache" file lock age val
  file="$dir/daily24_retail"; lock="$dir/daily24_retail.lock"
  mkdir -p "$dir" 2>/dev/null
  [ -f "$file" ] && val=$(cat "$file" 2>/dev/null)
  age=99999
  [ -f "$file" ] && age=$(( now - $(stat -f %m "$file" 2>/dev/null || echo 0) ))
  if [ "$age" -ge 60 ]; then
    if mkdir "$lock" 2>/dev/null; then
      (
        export PATH="$HOME/.bun/bin:$PATH"
        # sum last-24h retail from billing blocks, prorating any block that
        # straddles the 24h boundary by its in-window time fraction (an active
        # block, actualEndTime=null, is treated as ending now).
        cutoff=$(( now - 86400 ))
        v=$(bunx ccusage blocks --json 2>/dev/null | jq -r --argjson c "$cutoff" --argjson n "$now" '
          [ .blocks[] | select(.isGap|not)
            | (.startTime[0:19]+"Z"|fromdateiso8601) as $s
            | (if .actualEndTime then (.actualEndTime[0:19]+"Z"|fromdateiso8601) else $n end) as $e
            | (([$e,$n]|min) - ([$s,$c]|max)) as $ov
            | select($ov > 0 and $e > $s)
            | .costUSD * ($ov / ($e - $s)) ] | add // empty' 2>/dev/null)
        [ -n "$v" ] && printf '%s' "$v" > "$file"
        rmdir "$lock" 2>/dev/null                  # release before the slow daily update
        # keep ccusage current: bare bunx uses the newest cached build, so pull
        # @latest at most once a day — done outside the lock so a slow registry
        # can't stall the data fetch above.
        mark="$dir/ccusage_updated"
        if [ ! -f "$mark" ] || [ "$(( now - $(stat -f %m "$mark" 2>/dev/null || echo 0) ))" -ge 86400 ]; then
          bunx ccusage@latest --version >/dev/null 2>&1 && touch "$mark"
        fi
      ) >/dev/null 2>&1 &
      disown 2>/dev/null
    elif [ -d "$lock" ] && [ "$(( now - $(stat -f %m "$lock" 2>/dev/null || echo "$now") ))" -gt 300 ]; then
      rmdir "$lock" 2>/dev/null
    fi
  fi
  printf '%s' "$val"
}

# burn urgency: how early you exhaust relative to when the window resets.
# the smaller eta/reset, the more of the window you waste -> hotter.
burn_color() {
  local f
  f=$(awk -v e="$1" -v r="$2" 'BEGIN{printf "%d", (r>0)? e*100/r : 100}')
  if   [ "$f" -lt 50 ]; then printf '%s' "$RED"
  elif [ "$f" -lt 80 ]; then printf '%s' "$ORANGE"
  else                       printf '%s' "$GREEN"
  fi
}

# magnitude color: green < lo, orange < hi, red ≥ hi. usage: mag_color VALUE LO HI
mag_color() {
  awk -v v="$1" -v lo="$2" -v hi="$3" 'BEGIN{ if (v>=hi) exit 2; else if (v>=lo) exit 1; else exit 0 }'
  case $? in 2) printf '%s' "$RED";; 1) printf '%s' "$ORANGE";; *) printf '%s' "$GREEN";; esac
}

# eta_for: seconds until a window hits 100% at its pace so far, printed only
# if it would exhaust *before* it resets; empty otherwise.
eta_for() {
  local used=$1 resets=$2 dur=$3
  [ -z "$used" ] && return
  [ -z "$resets" ] && return
  awk -v u="$used" 'BEGIN{exit !(u>0)}' || return   # need real usage to extrapolate
  local rem=$(( resets - now ))
  [ "$rem" -le 0 ] && return
  local elapsed=$(( dur - rem ))
  [ "$elapsed" -lt 300 ] && return                  # too early in window to trust
  local t
  t=$(awk -v u="$used" -v e="$elapsed" 'BEGIN{printf "%d", (100-u)*e/u}')
  [ "$t" -ge "$rem" ] && return                     # window resets before you run out
  printf '%s' "$t"
}

# read-only git only: never take the optional index.lock, so a render can't
# contend with a concurrent commit/rebase/merge in the same repo.
export GIT_OPTIONAL_LOCKS=0

# --- git metadata ---
common_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
git_dir=$(git -C "$cwd" rev-parse --path-format=absolute --git-dir 2>/dev/null)
if [ -n "$common_dir" ]; then
  project=$(basename "$(dirname "$common_dir")")
  in_worktree=0
  [ "$common_dir" != "$git_dir" ] && in_worktree=1
else
  project=$(basename "$cwd")
  in_worktree=0
fi

[ -z "$branch" ] && branch=$(git -C "$cwd" branch --show-current 2>/dev/null)

# dirty marker
dirty=""
[ -n "$branch" ] && [ -n "$(git -C "$cwd" status --porcelain 2>/dev/null | head -1)" ] && dirty=" ●"

# parent branch from the branch's reflog (worktree only)
parent_branch=""
if [ "$in_worktree" = "1" ] && [ -n "$branch" ] && [ -n "$common_dir" ]; then
  first=$(git -C "$(dirname "$common_dir")" reflog show "$branch" --format='%gs' 2>/dev/null | tail -1)
  if [[ "$first" == *"Created from "* ]]; then
    parent_branch=${first##*Created from }
    parent_branch=${parent_branch#origin/}
    parent_branch=${parent_branch#refs/heads/}
  fi
fi

# ahead/behind: worktree → vs origin/<parent>, otherwise → vs @{upstream}
ahead_behind=""
if [ -n "$branch" ]; then
  if [ "$in_worktree" = "1" ] && [ -n "$parent_branch" ]; then
    ref="origin/$parent_branch"
    git -C "$cwd" rev-parse --verify --quiet "$ref" >/dev/null 2>&1 || ref="$parent_branch"
  else
    ref="@{upstream}"
  fi
  ab=$(git -C "$cwd" rev-list --count --left-right "${ref}...HEAD" 2>/dev/null)
  if [ -n "$ab" ]; then
    behind=$(awk '{print $1}' <<<"$ab")
    ahead=$(awk '{print $2}' <<<"$ab")
    [ "$ahead"  != "0" ] && ahead_behind+="↑$ahead"
    [ "$behind" != "0" ] && ahead_behind+="↓$behind"
  fi
fi

now=$(date +%s)
# cost velocity: last-24h retail spend, shown per-day (via ccusage blocks, background-cached)
costrate=""
day24=$(daily24_retail_cached)
if [ -n "$day24" ]; then
  disp=$(awk -v v="$day24" 'BEGIN{
    if      (v>=1000) printf "$%.1fk/d", v/1000
    else if (v>=100)  printf "$%.0f/d", v
    else              printf "$%.2f/d", v
  }')
  costrate="$(mag_color "$day24" 120 360)${disp}${RESET}"
fi

# --- assemble line 1: $/d · project · branch · lines · context ---
line1=()
[ -n "$costrate" ] && line1+=("⚡ $costrate")
[ -n "$project" ] && line1+=("📂 $project")
if [ -n "$branch" ]; then
  if [ "$in_worktree" = "1" ] && [ -n "$parent_branch" ]; then
    label="🌴 ${parent_branch}(${branch}${dirty})"
  elif [ "$in_worktree" = "1" ]; then
    label="🌴 ${branch}${dirty}"
  else
    label="🌱 ${branch}${dirty}"
  fi
  [ -n "$ahead_behind" ] && label+=" $ahead_behind"
  line1+=("$label")
fi
if [ "${lines_added:-0}" != "0" ] || [ "${lines_removed:-0}" != "0" ]; then
  line1+=("✂️ ${GREEN}+${lines_added:-0}${RESET} ${RED}-${lines_removed:-0}${RESET}")
fi
[ -n "$used" ] && [ "$(printf '%.0f' "$used")" != "0" ] && line1+=("💾 $(pct "$used")")

# --- assemble line 2: model · 🔥 weekly cluster · 5h ---
line2=()
if [ -n "$model" ]; then
  model_disp="${model/ (1M context)/ (1M)}"
  [ -n "$effort" ] && model_disp+=" $effort"
  line2+=("💡 $model_disp")
fi
weekly_retail=$(weekly_retail_cached)
spend=""
[ -n "$weekly_retail" ] && spend="$(mag_color "$weekly_retail" 1000 3000)$(fmt_money "$weekly_retail")${RESET}"

# --- 🔥 weekly cluster: retail spend · 7d% · 7d exhaust/reset (times only when burning) ---
burn=""
[ -n "$spend" ] && burn="$spend"
[ -n "$seven_day" ] && burn="${burn:+$burn }$(pct "$seven_day")"
eta7=$(eta_for "$seven_day" "$seven_day_resets" 604800)
if [ -n "$eta7" ]; then
  reset7=$(( seven_day_resets - now ))
  times="$(burn_color "$eta7" "$reset7")$(fmt_when "$(( now + eta7 ))")${RESET}/$(fmt_when "$seven_day_resets")"
  burn="${burn:+$burn }$times"
fi
[ -n "$burn" ] && line2+=("🔥 $burn")

# --- ⏱️ 5-hour window only ---
if [ -n "$five_hour" ]; then
  window="5h"
  if [ -n "$five_hour_resets" ]; then
    rem=$(( five_hour_resets - now ))
    if [ "$rem" -gt 0 ]; then
      consumed=$(( 18000 - rem ))
      [ "$consumed" -lt 0 ] && consumed=0
      h=$(( (consumed + 1800) / 3600 ))
      [ "$h" -lt 1 ] && h=1
      [ "$h" -gt 5 ] && h=5
      window="${h}h"
    fi
  fi
  line2+=("⏱️ ${window}: $(pct "$five_hour")")
fi

# --- render ---
l1=$(join ' · ' "${line1[@]}")
l2=$(join ' · ' "${line2[@]}")
if [ -n "$l2" ]; then
  printf '%s\n%s' "$l1" "$l2"
else
  printf '%s' "$l1"
fi
