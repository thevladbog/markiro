#!/bin/bash
RUN=$1
for i in $(seq 1 180); do
  S=$(curl -s -m 30 https://api.github.com/repos/thevladbog/markiro/actions/runs/$RUN)
  ST=$(echo "$S" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status"), d.get("conclusion"))' 2>/dev/null)
  echo "$(date +%H:%M:%S) $ST"
  case "$ST" in completed*) break;; esac
  sleep 120
done
curl -s -m 30 "https://api.github.com/repos/thevladbog/markiro/actions/runs/$RUN/jobs?per_page=100" | python3 -c '
import sys,json
d=json.load(sys.stdin)
for j in d.get("jobs",[]):
    print(j["status"], j["conclusion"], j["name"])
    if j.get("conclusion") not in (None,"success","skipped"):
        for s in j.get("steps",[]):
            if s.get("conclusion") not in (None,"success","skipped"):
                print("    FAILED STEP:", s["name"])
'
