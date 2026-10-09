#!/bin/sh
# Wartet, bis der nächtliche Lauf der Produktion (01:30 Berlin) fertig ist, und startet dann die Messung.
# Fragt nur /api/jobs ab, damit die Produktion während ihres Laufs nicht belastet wird.
cd "$(dirname "$0")/../.."
latest=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "2026-10-10T02:00:00" +%s)
while :; do
  state=$(curl -s https://stockcli.troop.at/api/jobs | jq -r '.runs[0] | "\(.startedAt) \(.status)"')
  echo "$(date -u +%H:%M) $state"
  case "$state" in
    2026-10-09T23:*" running"|2026-10-10T*" running") ;;
    2026-10-09T23:*|2026-10-10T*) break ;;
  esac
  [ "$(date -u +%s)" -ge "$latest" ] && { echo "kein fertiger Lauf bis 02:00 UTC, starte trotzdem"; break; }
  sleep 120
done
sleep 120
npx tsx measurements/dossier-guidance/lauf.ts --parallel 4 2>&1 | grep -v '^→\|^◇'
