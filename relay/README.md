# 中繼站（Cloudflare Worker）

作品總覽的「即時追蹤」頁透過這裡呼叫 Dify 客服知識庫。Dify 金鑰只存在 Cloudflare，不會出現在網頁或 GitHub。

- 正式環境：Cloudflare 後台 → Workers → ai-portfolio-relay → 設定 → 變數和密碼 → 新增密碼 `DIFY_API_KEY`
- 本機測試：把 `.dev.vars.example` 複製成 `.dev.vars` 填入金鑰（已被 .gitignore 排除），再執行 `npx wrangler dev`
- 限制：只接受作品總覽網域的請求；每個 IP 每分鐘 6 次；問題最長 300 字；只回傳執行步驟、取回的段落摘要與回答，不回傳內部 ID 或用量
