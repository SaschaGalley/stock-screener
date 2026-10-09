#!/bin/sh
# Wartet auf den nächtlichen distill-Abruf (01:30 Wien) und startet dann den Lauf.
cd "$(dirname "$0")/../.."
start=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "2026-10-09T23:52:00" +%s)
latest=$(date -j -u -f "%Y-%m-%dT%H:%M:%S" "2026-10-10T01:00:00" +%s)
while [ "$(date -u +%s)" -lt "$start" ]; do sleep 60; done
while :; do
  line=$(npx tsx measurements/dossier-guidance/lauf.ts --eignung 2>/dev/null | grep '^Eignung:')
  echo "$(date -u +%H:%M) $line"
  case "$line" in
    *"kein neues Paket"*) [ "$(date -u +%s)" -ge "$latest" ] && break ;;
    *) break ;;
  esac
  sleep 300
done
npx tsx measurements/dossier-guidance/lauf.ts --parallel 4 2>&1 | grep -v '^→\|^◇'
