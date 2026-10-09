# Eric 的工具箱

個人首頁，只給自己用：左側選工具，右側直接使用。發布在 https://ericlau1107.github.io/ （GitHub Pages）。

- **加工具**：在 `index.html` 的 `TOOLS` 清單加一筆。工具最好放在本倉庫的子資料夾（同一個網址底下），嵌入時瀏覽器才不會把資料分開存。
- **勞報單產生器**（`labor-report/`）：由另一個私人倉庫建置公開版後同步過來，指令是 `sh tools/sync-labor-report.sh`。同步腳本會確認公開版不含任何預填資料才放行。
- **案務專案工作台**（`#project-desk`）：從工具箱開啟既有私人 Sites 工作台，需登入原本的 ChatGPT 帳號。登入與 D1 資料保存由工作台提供；GitHub Pages 只提供公開入口，不複製案件資料或後端程式。`TOOLS` 設定 `mode: 'external'` 的工具以新分頁連結開啟。
- **個人記帳／收支日常**（`money-report/`）：可直接新增收支、退款、帳戶轉帳，管理存款與負債，查詢歷史資產、每月分析、消費分佈及預算；JSON 完整備份/還原、CSV 匯出。初始帳本為空，帳目只存在該裝置瀏覽器 IndexedDB，沒有銀行連線或跨裝置同步。原本月報檢視器保留在 `money-report/report-viewer.html`，沿用既有匯入資料。原始碼在 `Dev/systems/money-report/`，以 `sh tools/sync-toolbox.sh` 同步兩個 HTML；只發布程式與經守門的虛構月報樣本。
- **健康與健身／日日動**（`health-fitness/`）：手動健康日誌、可保存的 30 天月計畫與每日起步課表、依當日健身課表與目標連動三餐、可選訓練時間及運動前後餐食／過敏篩選／睡眠時段規劃、實際生活紀錄、重量組次與訓練進度、JSON 備份/還原及 CSV 匯出。初始資料空白，只存在該瀏覽器 IndexedDB；没有穿戴裝置、醫療院所或 AI API 串接。原始碼在 `Dev/systems/health-fitness/`，以 `sh tools/sync-toolbox.sh` 同步公開 HTML。
- **注意**：本倉庫和網頁都是公開的，只放本身公開、不含個資的工具。`robots.txt` 擋搜尋引擎爬 `labor-report/`、`money-report/`，首頁本身帶 noindex。
- **同網域規則（不可動）**：這個網域（含 `/portfolio/`、`/ledger-house/` 等其他倉庫的 Pages）所有頁面共用同一個 origin，任何一頁執行的程式都讀得到記帳月報、勞報單存在瀏覽器裡的資料。所以**網域上的頁面只能執行自己的程式；外部程式必須鎖定版本＋SRI，永遠不放廣告或追蹤程式**。推上 main 前跑 `python3 tools/check-scripts.py`。
- **作品集網站**（`#portfolio`）：另一個公開倉庫 `ericlau1107/portfolio` 的 GitHub Pages，網址 https://ericlau1107.github.io/portfolio/。跟工具箱同一個網址底下，所以直接嵌在右側；內容更新在作品集那邊發布（`~/Desktop/03_作品集/網站/_publish-pages.sh`），工具箱不用跟著改。
- `ledger-house/` 是另一個倉庫（記帳小屋）的 GitHub Pages，不在本倉庫。
