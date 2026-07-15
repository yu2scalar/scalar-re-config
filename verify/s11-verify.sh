#!/usr/bin/env bash
# Live verification of auth/TLS: starts serve in 3 configurations and checks behavior.
# Golden checks are covered separately by golden-check.sh (against a serve started with TLS_ENABLED=false).
set -u
JAR=$(ls build/libs/scalar-re-config-tool-*.jar | head -1)
PORT=8088
PASS=0; FAIL=0
ok(){ echo "  PASS: $1"; PASS=$((PASS+1)); }
ng(){ echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

wait_up(){ # $1=scheme
  for i in $(seq 1 60); do
    curl -sk "$1://localhost:$PORT/" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}
stop(){ [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""; }
trap stop EXIT

echo "=== Scenario 1: default (HTTPS self-signed, no auth) ==="
CONFIG_TOOL_OPEN_BROWSER=false java -jar "$JAR" --mode=serve >/tmp/s11-1.log 2>&1 &
PID=$!
if wait_up https; then
  grep -q "generated self-signed cert (CN=ScalarRE Config Tool" /tmp/s11-1.log && ok "startup log: self-signed cert" || ng "startup log: self-signed cert"
  grep -q "\[auth\] disabled" /tmp/s11-1.log && ok "startup log: auth disabled" || ng "startup log: auth disabled"
  code=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:$PORT/)
  [ "$code" = 200 ] && ok "GET / over https = 200" || ng "GET / https = $code"
  # http should NOT serve (TLS on)
  hcode=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/ 2>/dev/null)
  [ "$hcode" != 200 ] && ok "plain http not served (got '$hcode')" || ng "plain http unexpectedly 200"
  meta=$(curl -sk https://localhost:$PORT/api/meta)
  echo "$meta" | grep -q '"authEnabled":false' && echo "$meta" | grep -q '"destructiveOpsAllowed":false' \
    && ok "/api/meta = auth/destructive false" || ng "/api/meta unexpected: $meta"
  # recreate gate (no auth) -> 403 AuthRequired (DB-independent: gate is before DB)
  gcode=$(curl -sk -o /tmp/s11-rec.json -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{}' "https://localhost:$PORT/api/db/namespaces/foo/recreate?confirm=true")
  if [ "$gcode" = 403 ] && grep -q AuthRequired /tmp/s11-rec.json; then ok "recreate gated 403 AuthRequired"; else ng "recreate gate code=$gcode body=$(cat /tmp/s11-rec.json)"; fi
  # init?recreate=true also gated
  icode=$(curl -sk -o /tmp/s11-init.json -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -d '{}' "https://localhost:$PORT/api/db/init?recreate=true&confirm=true")
  [ "$icode" = 403 ] && ok "init?recreate gated 403" || ng "init recreate gate code=$icode"
  # cert CN + SAN
  certinfo=$(echo | openssl s_client -connect localhost:$PORT 2>/dev/null | openssl x509 -noout -subject -ext subjectAltName 2>/dev/null)
  echo "  cert: $certinfo"
  echo "$certinfo" | grep -q "ScalarRE Config Tool" && ok "cert CN" || ng "cert CN"
  echo "$certinfo" | grep -qi "DNS:localhost" && echo "$certinfo" | grep -q "127.0.0.1" && ok "cert SAN localhost/127.0.0.1" || ng "cert SAN"
else
  ng "scenario1 server did not come up"; cat /tmp/s11-1.log | tail -20
fi
stop

echo "=== Scenario 2: ADMIN_PASSWORD set (HTTPS + Basic) ==="
ADMIN_PASSWORD=secret CONFIG_TOOL_OPEN_BROWSER=false java -jar "$JAR" --mode=serve >/tmp/s11-2.log 2>&1 &
PID=$!
if wait_up https; then
  grep -q "HTTP Basic enabled" /tmp/s11-2.log && ok "startup log: Basic enabled" || ng "startup log: Basic enabled"
  # unauthenticated API -> 401
  ucode=$(curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' https://localhost:$PORT/api/preview)
  [ "$ucode" = 401 ] && ok "unauth /api/preview = 401" || ng "unauth /api/preview = $ucode"
  # authenticated API -> not 401 (200)
  acode=$(curl -sk -o /dev/null -w '%{http_code}' -u admin:secret -X POST -H 'Content-Type: application/json' -d '{}' https://localhost:$PORT/api/preview)
  [ "$acode" = 200 ] && ok "auth /api/preview = 200" || ng "auth /api/preview = $acode"
  # bypassed endpoints reachable without creds
  rcode=$(curl -sk -o /dev/null -w '%{http_code}' https://localhost:$PORT/)
  [ "$rcode" = 200 ] && ok "GET / bypass = 200 (no creds)" || ng "GET / bypass = $rcode"
  mcode=$(curl -sk -o /tmp/s11-meta2.json -w '%{http_code}' https://localhost:$PORT/api/meta)
  if [ "$mcode" = 200 ] && grep -q '"destructiveOpsAllowed":true' /tmp/s11-meta2.json; then ok "/api/meta bypass + destructive true"; else ng "meta2 code=$mcode body=$(cat /tmp/s11-meta2.json)"; fi
  # recreate with auth passes the gate (NOT 403/401). DB unreachable -> expect non-gate failure.
  gcode=$(curl -sk -o /tmp/s11-rec2.json -w '%{http_code}' -u admin:secret -X POST -H 'Content-Type: application/json' \
    -d '{}' "https://localhost:$PORT/api/db/namespaces/foo/recreate?confirm=true")
  if [ "$gcode" != 403 ] && [ "$gcode" != 401 ]; then ok "recreate passes gate when authed (code=$gcode)"; else ng "recreate still blocked when authed: $gcode $(cat /tmp/s11-rec2.json)"; fi
else
  ng "scenario2 server did not come up"; tail -20 /tmp/s11-2.log
fi
stop

echo "=== Scenario 3: TLS_ENABLED=false (plain HTTP) ==="
TLS_ENABLED=false CONFIG_TOOL_OPEN_BROWSER=false java -jar "$JAR" --mode=serve >/tmp/s11-3.log 2>&1 &
PID=$!
if wait_up http; then
  grep -q "\[tls\] disabled (plain HTTP)" /tmp/s11-3.log && ok "startup log: tls disabled" || ng "startup log: tls disabled"
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/)
  [ "$code" = 200 ] && ok "GET / over plain http = 200" || ng "GET / http = $code"
else
  ng "scenario3 server did not come up"; tail -20 /tmp/s11-3.log
fi
stop

echo "=================================="
echo "RESULT: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
