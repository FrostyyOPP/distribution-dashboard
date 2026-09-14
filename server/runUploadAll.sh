#!/bin/zsh
# Upload every translated English caption set that isn't on Udemy yet.
cd "$(dirname "$0")"
# better-sqlite3 needs Node 24 here; set NODE_BIN to point at it explicitly.
NODE="${NODE_BIN:-$(command -v node)}"
DONE_FILE=/tmp/uploaded_courses.txt
touch $DONE_FILE
for S in $(ls caption-files-en); do
  grep -qx "$S" $DONE_FILE && { echo "skip $S"; continue; }
  N=$(ls caption-files-en/$S | wc -l | tr -d ' ')
  echo "=== $S ($N files) ==="
  COURSE=$S LANG_CODE=en_US UPLOAD_CONCURRENCY=6 $NODE uploadCaptions.js > /tmp/up_$S.log 2>&1
  OK=$(grep -c 'published caption' /tmp/up_$S.log); FAIL=$(grep -c 'FAILED' /tmp/up_$S.log)
  echo "   published $OK, failed $FAIL"
  [ "$FAIL" -eq 0 ] && echo "$S" >> $DONE_FILE
done
echo "ALL UPLOADS DONE"
