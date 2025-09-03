# Xero Media Accrual Plug-in (MVP)

Automates the classic media agency flow in Xero:
- Creates a **Sales Invoice** (ACCREC, authorised) when you start a campaign.
- Posts a **Manual Journal** to accrue expected media costs (Dr Media Costs / Cr Media Accrual Control).
- Listens to **Xero Webhooks** for supplier bills; **re-codes draft bills** to Accrual Control, optionally **authorises**, and posts **variance** journals.

## Endpoints
- `GET /` → health check
- `GET /connect` → OAuth login to Xero
- `GET /callback` → OAuth redirect handler
- `POST /campaigns` → body: `{ clientContactId|clientContactName, campaignRef, saleNet, expectedCostNet, dueDate?, description?, salesTaxName? }`

## Deploy (Render + Xero)
1. Create a Web App in **Xero Developer** (Web App type). Copy Client ID/Secret.  
2. Create a **Web Service** in **Render** (Node runtime):
   - Build: `npm install && npm run build`
   - Start: `npm start`
   - ENV: see `.env.example`
3. Update Xero app:
   - Redirect URI: `https://YOUR-RENDER-URL/callback`
   - Webhooks Endpoint: `https://YOUR-RENDER-URL/webhooks/xero`
   - Copy Signing Key → `XERO_WEBHOOK_KEY` in Render.
4. Visit `https://YOUR-RENDER-URL/connect`, authorise Demo Company.
5. POST `/campaigns` to create invoice + accrual. Create a **Draft** supplier bill with the same `Reference` to trigger recode/variance.

**Notes:** Journals have no VAT; bills keep VAT on the bill lines; only Draft/Submitted bills are recoded.
