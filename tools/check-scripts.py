#!/usr/bin/env python3
"""同網域安全檢查：ericlau1107.github.io 底下所有頁面共用同一個 origin，
任何一頁執行的程式都讀得到其他頁存在瀏覽器裡的資料（例如記帳月報的 IndexedDB）。
所以規則是：網域上的頁面只能執行自己的程式；真的要載入外部程式，必須鎖定版本＋SRI（integrity 雜湊）。
用法：python3 tools/check-scripts.py   （推上 main 前跑；不通過就不要推）
"""
import pathlib, re, sys
ROOT = pathlib.Path(__file__).resolve().parent.parent
bad = []
for p in sorted(ROOT.rglob('*.html')):
    if '.git' in p.parts:
        continue
    t = p.read_text(encoding='utf-8', errors='replace')
    rel = p.relative_to(ROOT)
    # 1 靜態 <script src="外部網址"> 一定要有 integrity
    for m in re.finditer(r'<script\b[^>]*\bsrc\s*=\s*["\']?(https?:)?//[^>]*>', t, re.I):
        if 'integrity=' not in m.group(0):
            bad.append(f'{rel}: 外部 <script> 沒有 integrity：{m.group(0)[:120]}')
    # 2 動態載入外部程式（createElement('script')）的檔案，必須也設定 integrity
    if re.search(r"createElement\(\s*['\"]script['\"]\s*\)", t) and re.search(r'https?://[^"\'\s]+\.js', t) and not re.search(r'\.integrity\s*=', t):
        bad.append(f'{rel}: 動態載入外部 .js 但沒有設定 integrity')
    # 3 不准出現常見的追蹤／廣告程式
    for name in ('googletagmanager', 'google-analytics', 'gtag(', 'facebook.net', 'hotjar', 'clarity.ms', 'adsbygoogle'):
        if name in t:
            bad.append(f'{rel}: 含追蹤／廣告程式（{name}）')
if bad:
    print('不通過：\n  ' + '\n  '.join(bad))
    sys.exit(1)
print(f'通過：{sum(1 for p in ROOT.rglob("*.html") if ".git" not in p.parts)} 個頁面都沒有未鎖定的外部程式或追蹤程式')
