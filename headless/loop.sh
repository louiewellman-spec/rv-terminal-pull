#!/usr/bin/env bash
# RV Terminal · pull chain.
# One GitHub Actions job pulls Stripe every 15 minutes for ~5h35m; the workflow then dispatches its
# own successor. GitHub's free-tier cron is best-effort (8-9 Sep 2026: 4 ticks fired in 12 h instead
# of 48), so the cron is only a backup that restarts a dead chain.
#   PERIOD  seconds between pull starts (900)
#   OFFSET  seconds past the hour for the slots (420 → :07 :22 :37 :52, the minutes run.js's
#           slow-lane gate expects: only the :07 tick of hours 0/6/12/18 takes the slow lane)
#   BUDGET  seconds this job may keep looping (5h35m; GitHub kills any job at 6h)
#   PULL    the command run at each slot (node headless/run.js)
#   NO_GIT  set to skip the per-slot checkout refresh (local tests)
set -u
PERIOD=${PERIOD:-900}; OFFSET=${OFFSET:-420}; BUDGET=${BUDGET:-20100}; PULL=${PULL:-node headless/run.js}
start=$(date +%s); end=$((start+BUDGET)); runs=0; fails=0
say(){ echo "$(date -u +%H:%M:%S)  $*"; }
fmt(){ date -u -d @"$1" +%H:%M:%S 2>/dev/null || date -u -r "$1" +%H:%M:%S; }
while :; do
  # a newly deployed rv_terminal.html should be used within one slot, not one chain
  if [ -z "${NO_GIT:-}" ]; then
    git fetch -q --depth=1 origin main && git reset -q --hard origin/main || say "git refresh failed - using the checkout as is"
  fi
  runs=$((runs+1)); say "pull #$runs"
  $PULL; rc=$?
  if [ $rc -eq 0 ]; then say "pull #$runs ok"; else fails=$((fails+1)); say "::warning::pull #$runs failed (exit $rc)"; fi
  # The private repo's own crons (Discord hourly, Revolut 4-hourly) get dropped by GitHub just like
  # this one's did, so the chain kicks them off itself: Discord on the first slot of every hour,
  # Revolut on the first slot of every 4th hour. Needs PRIVATE_DISPATCH_TOKEN (a fine-grained PAT
  # with Actions: write on louiewellman-spec/rv-terminal); silently skipped until it exists.
  if [ -n "${PRIVATE_DISPATCH_TOKEN:-}" ]; then
    hr=$(date -u +%-H); mn=$(date -u +%-M)
    if [ "$mn" -lt 15 ]; then
      say "dispatching rv-discord-sync on the private repo"
      GH_TOKEN="$PRIVATE_DISPATCH_TOKEN" ${GH:-gh} workflow run rv-discord-sync.yml -R louiewellman-spec/rv-terminal --ref main || say "::warning::discord dispatch failed"
      if [ $((hr % 4)) -eq 0 ]; then
        say "dispatching rv-revolut-sync on the private repo"
        GH_TOKEN="$PRIVATE_DISPATCH_TOKEN" ${GH:-gh} workflow run rv-revolut-sync.yml -R louiewellman-spec/rv-terminal --ref main || say "::warning::revolut dispatch failed"
      fi
    fi
  fi
  now=$(date +%s)
  next=$(( (now-OFFSET)/PERIOD*PERIOD + PERIOD + OFFSET ))
  if [ $next -ge $end ]; then say "budget reached: $runs pulls, $fails failed"; break; fi
  say "next pull at $(fmt $next)"; sleep $((next-now))
done
if [ $fails -lt $runs ]; then
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "alive=true" >> "$GITHUB_OUTPUT"
  say "chain alive - the workflow dispatches the next link"; exit 0
fi
say "every pull failed - not chaining; the cron backup will retry"; exit 1
