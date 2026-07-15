#!/usr/bin/env bash
#
# golden-check.sh — regression check against frozen golden outputs.
#
# The frozen goldens (verify/golden/) originate from the output the original Go
# implementation (kept out of this repo) produced for the same inputs, later
# re-frozen from the Java output as noted below. This script mechanically
# compares the same endpoint outputs of a running Spring Boot server against
# them. Any single mismatch makes the script exit 1.
#
# Usage:
#   1) Start Spring Boot:  java -jar build/libs/scalar-re-config-tool-*.jar   (default :8088)
#   2) ./verify/golden-check.sh [BASE_URL]
#
# Required tools: curl, jq, diff
#
# Golden provenance (at freeze time):
#   - input       verify/inputs/canonical-config.json
#                 = result of loading frontend/current-scalar-re-config.yml via the
#                   Go /api/load (derived from defaults.ts; covers all storage kinds
#                   + all delivery types)
#   - preview     verify/golden/preview-response.json  (Go /api/preview)
#   - save        verify/golden/saved-config.yml       (re-frozen from the Java output)
#
# Goldens re-frozen on 2026-06-19:
#   - Added connection-params: sslMode=REQUIRED to the canonical input's mysql entry
#     (for the DB verify feature). This makes mysql's contact_points
#     ...:3306/?sslMode=REQUIRED, and the preview/save goldens were re-frozen from
#     the Java output. connection-params is a Java-side addition that the Go
#     prototype does not have, so for this input the preview no longer byte-matches
#     Go (all other lines still match). The goldens are operated as "frozen Java
#     output" = the regression baseline.
#
# YAML output policy (settled during the Java port = clean normalization):
#   - preview (scalardb.properties) matches Go at the string level (except the
#     connection-params line).
#   - save (YAML) treats Java's clean normalized output as canonical; the save
#     golden was re-frozen from the Java output (2026-06-19). The only intentional
#     differences from Go are:
#       * cleanup-retention-ms: 86400000  (Java integer; Go emitted scientific
#         notation 8.64e+07)
#       * schema-version / expires-at use single quotes (Go used double quotes;
#         both are valid YAML)
#     Emitting large integers as plain integers is safer for a config that ScalarRE
#     reads, and keeps the load round-trip clean. indent=4 / fixed top-level order /
#     ascending nested keys / empty map {} all match Go.
set -uo pipefail

BASE_URL="${1:-http://127.0.0.1:8088}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN="$HERE/inputs"
GOLDEN="$HERE/golden"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail=0
pass() { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; fail=1; }

echo "golden-check against $BASE_URL"

# --- 1) /api/preview : scalardb properties ---------------------------------
curl -s -X POST "$BASE_URL/api/preview" -H 'Content-Type: application/json' \
  --data-binary @"$IN/canonical-config.json" -o "$WORK/preview.json"
# Compare .scalardb_properties line by line (expand JSON escapes to real text)
jq -r '.scalardb_properties' "$GOLDEN/preview-response.json" > "$WORK/preview.golden.txt"
jq -r '.scalardb_properties' "$WORK/preview.json"            > "$WORK/preview.actual.txt"
if diff -u "$WORK/preview.golden.txt" "$WORK/preview.actual.txt" > "$WORK/preview.diff"; then
  pass "/api/preview scalardb_properties"
else
  bad "/api/preview scalardb_properties"; sed -n '1,40p' "$WORK/preview.diff"
fi

# --- 2) /api/save : YAML write ---------------------------------------------
SAVE_OUT="$WORK/saved.yml"
jq -n --slurpfile c "$IN/canonical-config.json" --arg p "$SAVE_OUT" \
  '{path:$p, config:$c[0]}' > "$WORK/save-req.json"
curl -s -X POST "$BASE_URL/api/save" -H 'Content-Type: application/json' \
  --data-binary @"$WORK/save-req.json" -o "$WORK/save-resp.json"
if [ -f "$SAVE_OUT" ] && diff -u "$GOLDEN/saved-config.yml" "$SAVE_OUT" > "$WORK/save.diff"; then
  pass "/api/save YAML"
else
  bad "/api/save YAML"; [ -f "$WORK/save.diff" ] && sed -n '1,40p' "$WORK/save.diff"
fi

# --- 3) /api/load : round-trip (read back the save result, expect it to equal the input config) ---
if [ -f "$SAVE_OUT" ]; then
  curl -s -X POST "$BASE_URL/api/load" -H 'Content-Type: application/json' \
    -d "{\"path\":\"$SAVE_OUT\"}" -o "$WORK/loaded.json"
  # Normalize key order before comparing
  jq -S . "$IN/canonical-config.json" > "$WORK/in.norm.json"
  jq -S . "$WORK/loaded.json"         > "$WORK/loaded.norm.json"
  if diff -u "$WORK/in.norm.json" "$WORK/loaded.norm.json" > "$WORK/load.diff"; then
    pass "/api/load round-trip"
  else
    bad "/api/load round-trip"; sed -n '1,40p' "$WORK/load.diff"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then echo "ALL GOLDEN CHECKS PASSED"; else echo "GOLDEN MISMATCH (exit 1)"; fi
exit "$fail"
