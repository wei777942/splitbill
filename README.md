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

## UI rules (from user feedback — keep)

- Buttons never wrap their text (`white-space: nowrap`).
- No inline destructive × on chips. Member chips on the trip card are display-only; edits/deletes go through 「編輯成員」 (delete asks to confirm and is blocked if the member is used in an expense).
- Expense list: date tabs, tinted date bands, thin dividers only between items, inline 編輯/刪除, untitled → 「X 付的支出」.
- Both default trip currencies are TWD (editable in settings).
- Test at iPhone size (390×844) before shipping.
- Per-member owed/paid/balance figures (trip summary, per-day detail, per-expense shares, and the sheet preview) are collapsed by default behind 「各家應付 ▸」; the 結算 page always shows the full result.
- 記一筆: amount, currency and rate sit on ONE row (金額 | 幣別 | × 匯率). The rate chip is hidden for the home currency; tapping it edits (manual), clearing it returns to the Bank of Taiwan rate.
- Number fields are `type=text inputmode=decimal` (never type=number) and ≥16px; inputs must never sit inside a `<label>` with other controls; don't size inputs via generic `.check-item input` rules (it squashed per-person amount fields to 18px).
- Test in WebKit with devices['iPhone 13'] and tap(), not click().
