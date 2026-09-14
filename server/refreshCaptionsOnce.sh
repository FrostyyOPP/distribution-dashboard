#!/bin/zsh
# One-shot: refresh the Captions column in the dashboard, then remove its own
# launchd job so it cannot fire again.
#
# Exists because Udemy scraping is switched OFF in the daily job (update-all.js,
# 2026-08-13), so the captions table does not refresh on its own — it has to be
# run by hand after caption work, or the dashboard keeps showing the old counts.
cd "$(dirname "$0")"
# better-sqlite3 needs Node 24 here; set NODE_BIN to point at it explicitly.
NODE="${NODE_BIN:-$(command -v node)}"
LABEL=com.starweaver.dashboard-caption-refresh

echo "=== caption refresh $(date '+%Y-%m-%d %H:%M:%S') ==="
BEFORE=$($NODE -e "const d=require('better-sqlite3')('dashboard.db',{readonly:true});console.log(d.prepare('select max(updated_at) u from captions').get().u)")
echo "table was last updated: $BEFORE"

$NODE scrapeCaptions.js
RC=$?

if [ $RC -eq 0 ]; then
  $NODE -e "
    const d=require('better-sqlite3')('dashboard.db',{readonly:true});
    const r=d.prepare('select count(*) n, max(updated_at) u from captions').get();
    const rows=d.prepare('select languages from captions').all().map(x=>JSON.parse(x.languages));
    const dist={}; rows.forEach(L=>{dist[L.length]=(dist[L.length]||0)+1;});
    console.log('now: '+r.n+' courses, updated '+r.u);
    console.log('languages per course: '+JSON.stringify(dist));
    console.log('courses with 1-3 languages: '+rows.filter(L=>L.length>=1&&L.length<=3).length);
  "
  echo "✅ done — removing the one-shot job"
  launchctl bootout gui/$(id -u)/$LABEL 2>/dev/null
  rm -f ~/Library/LaunchAgents/$LABEL.plist
else
  echo "❌ scrape failed (exit $RC) — job left in place; most likely the Udemy session expired."
  echo "   Reconnect Udemy, then run: cd ~/udemy-dashboard/server && ./refreshCaptionsOnce.sh"
fi
