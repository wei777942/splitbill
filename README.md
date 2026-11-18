# 旅行分帳 (Splitbill)

Mobile web trip bill splitting app (Traditional Chinese UI).

- Single-page frontend (`public/index.html`)
- Node + SQLite + SSE realtime sync (no login; join by share code/link)
- Dual currency; each expense stores its own rate (Bank of Taiwan cash selling for the expense date via `/api/bot-rate`, editable)
- Split modes: 均分 / 按人頭 (member headcount) / 自訂金額 / 自訂比例
- 結算總表 + client-side .xlsx export (ExcelJS served at `/vendor/exceljs.min.js`): 明細 with =C*E formulas and red-row check, 結算 with SUMIF/SUM and transfer sentence
- localStorage offline cache

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy

Render free web service (Node). Build: `npm install`. Start: `npm start`.
