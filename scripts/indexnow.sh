#!/usr/bin/env bash
# Tell IndexNow search engines (Bing, Yandex, Seznam, Naver, Yep) that the sitemap URLs changed.
# usage: scripts/indexnow.sh   (after a deploy that changed public pages; the key file is public/4a7dd3ea907c5d6e5ef56d54c91716d3.txt)
set -euo pipefail
KEY=4a7dd3ea907c5d6e5ef56d54c91716d3
HOST=oceanlife.bristleconelab.org
URLS=$(curl -s https://$HOST/sitemap.xml | grep -o '<loc>[^<]*' | sed 's/<loc>//' | python3 -c 'import json,sys;print(json.dumps([l.strip() for l in sys.stdin if l.strip()]))')
curl -s -o /dev/null -w "IndexNow HTTP %{http_code}\n" -H 'Content-Type: application/json; charset=utf-8' \
  -d "{\"host\":\"$HOST\",\"key\":\"$KEY\",\"keyLocation\":\"https://$HOST/$KEY.txt\",\"urlList\":$URLS}" \
  https://api.indexnow.org/indexnow
