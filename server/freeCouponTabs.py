"""Workbook with one tab per coupon code: every course carrying it, its parent
course / batch / SME, redemptions used and left, dates and the coupon link.

    python3 freeCouponTabs.py FREEOCT,FREEOCT1 "~/Downloads/Udemy free coupons.xlsx"

Reads dashboard.db, so run scrapeCoupons.js first for current redemption counts.
A coupon that has run out is listed with no link — sharing it would send
people to full price.
"""
import sqlite3, json, os, sys, urllib.request
from datetime import datetime, timezone
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

CODES = sys.argv[1].split(',')
OUT = os.path.expanduser(sys.argv[2])
db = sqlite3.connect(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dashboard.db'))
now = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
scraped = db.execute('select max(updated_at) from coupons').fetchone()[0]
rows = db.execute("""select c.code, u.title, u.url, c.max_uses, c.used, c.start_time, c.end_time, c.status
  from coupons c left join udemy_real_course_ids u on u.course_id = c.course_id
  where c.code in (%s) and c.end_time > ? order by c.code, u.title""" % ','.join('?' * len(CODES)), (*CODES, now)).fetchall()

# Parent course, batch and SME from the royalty tool — the same source the other coupon reports use.
titles = sorted({r[1] for r in rows if r[1]})
par = {}
try:
    req = urllib.request.Request('http://127.0.0.1:5059/api/probe', data=json.dumps({'titles': titles, 'platform': 'Udemy'}).encode(), headers={'content-type': 'application/json'})
    res = json.load(urllib.request.urlopen(req, timeout=60))['results']
    par = {t: (r.get('hit') or {}) for t, r in zip(titles, res)}
except Exception as e:
    print('course-map unavailable — parent/batch/SME left blank:', e)

fmt = lambda s: datetime.fromisoformat(s.replace('Z', '+00:00')).strftime('%d %b %Y, %H:%M UTC') if s else ''
AR = 'Arial'
HF = Font(name=AR, bold=True, color='FFFFFF', size=10); HDR = PatternFill('solid', fgColor='0F244F')
F = Font(name=AR, size=10); B = Font(name=AR, size=10, bold=True)
LF = Font(name=AR, size=10, color='1B3A8C', underline='single'); GREY = Font(name=AR, size=10, color='9AA1AC', italic=True)
TH = Border(bottom=Side('thin', color='DDE1E8'))
H = ['#', 'Course', 'Parent course', 'Batch', 'SME', 'Status', 'Max uses', 'Used', 'Redemptions left', 'Starts', 'Ends', 'Coupon link']
W = [5, 56, 48, 18, 22, 10, 10, 8, 16, 22, 22, 90]

wb = Workbook(); wb.remove(wb.active)
for code in CODES:
    cs = [r for r in rows if r[0] == code]
    # Live courses first, so the links worth sharing are at the top.
    cs.sort(key=lambda r: (r[7] == 'used_up' or (r[3] is not None and (r[4] or 0) >= r[3]), r[1] or ''))
    ws = wb.create_sheet(code[:31])
    ws.append(H)
    for i, h in enumerate(H, 1):
        c = ws.cell(1, i); c.font = HF; c.fill = HDR; c.alignment = Alignment(vertical='center')
        ws.column_dimensions[get_column_letter(i)].width = W[i - 1]
    for n, (_, title, url, mx, used, st, en, status) in enumerate(cs, 1):
        p = par.get(title, {})
        usedup = status == 'used_up' or (mx is not None and (used or 0) >= mx)
        link = f'{url}?couponCode={code}' if url and not usedup else ''
        left = None if mx is None else max(0, mx - (used or 0))
        ws.append([n, title or '(unknown course)', p.get('parent') or '—', p.get('batch') or '—', p.get('sme') or '—',
                   'Used up' if usedup else 'Live', mx, used or 0, left, fmt(st), fmt(en), link or 'used up — link no longer applies'])
        r = ws.max_row
        for x in ws[r]: x.font = F; x.border = TH
        if link: ws.cell(r, 12).hyperlink = link; ws.cell(r, 12).font = LF
        else: ws.cell(r, 12).font = GREY
    last = ws.max_row
    ws.append([])
    ws.append([None, f'{len(cs)} courses · data from Udemy {fmt(scraped)}', None, None, None, None,
               f'=SUM(G2:G{last})', f'=SUM(H2:H{last})', f'=SUM(I2:I{last})'])
    for x in ws[ws.max_row]: x.font = B
    ws.freeze_panes = 'C2'; ws.auto_filter.ref = f'A1:L{last}'
    live = [r for r in cs if not (r[7] == 'used_up' or (r[3] is not None and (r[4] or 0) >= r[3]))]
    print(f'{code}: {len(cs)} courses · {len(live)} live · {sum(r[4] or 0 for r in cs)} used · {sum(max(0, (r[3] or 0) - (r[4] or 0)) for r in cs)} left · ends {min((r[6] for r in cs), default="")}'
          f' · no title {sum(1 for r in cs if not r[1])}')
wb.calculation.fullCalcOnLoad = True
wb.save(OUT)
print(OUT)
