# Eric 的工具箱

個人首頁，只給自己用：左側選工具，右側直接使用。發布在 https://ericlau1107.github.io/ （GitHub Pages）。

- **加工具**：在 `index.html` 的 `TOOLS` 清單加一筆。工具最好放在本倉庫的子資料夾（同一個網址底下），嵌入時瀏覽器才不會把資料分開存。
- **勞報單產生器**（`labor-report/`）：由另一個私人倉庫建置公開版後同步過來，指令是 `sh tools/sync-labor-report.sh`。同步腳本會確認公開版不含任何預填資料才放行。
- **案務專案工作台**（`#project-desk`）：從工具箱開啟既有私人 Sites 工作台，需登入原本的 ChatGPT 帳號。登入與 D1 資料保存由工作台提供；GitHub Pages 只提供公開入口，不複製案件資料或後端程式。`TOOLS` 設定 `mode: 'external'` 的工具以新分頁連結開啟。
- **注意**：本倉庫和網頁都是公開的，只放本身公開、不含個資的工具。`robots.txt` 擋搜尋引擎爬 `labor-report/`，首頁本身帶 noindex。
- **作品集網站**（`#portfolio`）：另一個公開倉庫 `ericlau1107/portfolio` 的 GitHub Pages，網址 https://ericlau1107.github.io/portfolio/。跟工具箱同一個網址底下，所以直接嵌在右側；內容更新在作品集那邊發布（`~/Desktop/03_作品集/網站/_publish-pages.sh`），工具箱不用跟著改。
- `ledger-house/` 是另一個倉庫（記帳小屋）的 GitHub Pages，不在本倉庫。
