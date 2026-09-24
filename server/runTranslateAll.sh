#!/bin/zsh
# Google's endpoint enforces a volume quota, not a concurrency limit: sustained
# traffic gets the IP blocked for a while regardless of how many workers run.
# translateVttSentences.js skips files that already exist, so a blocked run is
# resumable — just wait out the block and start again. Loop until every target
# course is complete, backing off when blocked.
cd "$(dirname "$0")"
# better-sqlite3 needs Node 24 here; set NODE_BIN to point at it explicitly.
NODE="${NODE_BIN:-$(command -v node)}"
SLUGS=$($NODE -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/caption_gaps.json','utf8')).map(g=>g.slug).join(','))")
TARGETS=$($NODE -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/caption_gaps.json','utf8')).length)")
CONC=${CONC:-5}
for attempt in $(seq 1 200); do
  DONE=$(ls caption-files-en 2>/dev/null | wc -l | tr -d ' ')
  echo "[$(date +%H:%M:%S)] attempt $attempt — $DONE/$TARGETS courses complete"
  if [ "$DONE" -ge "$TARGETS" ]; then echo "ALL COURSES TRANSLATED"; break; fi
  SRC_DIR=caption-files-src-es COURSE="$SLUGS" CONCURRENCY=$CONC $NODE translateVttSentences.js >> /tmp/trans_loop.log 2>&1
  if [ $? -eq 0 ]; then echo "[$(date +%H:%M:%S)] clean pass"; else echo "[$(date +%H:%M:%S)] blocked — backing off 8m"; sleep 480; fi
done
echo "FINISHED: $(ls caption-files-en 2>/dev/null | wc -l | tr -d ' ')/$TARGETS courses, $(find caption-files-en -name '*.vtt' | wc -l | tr -d ' ') files"
