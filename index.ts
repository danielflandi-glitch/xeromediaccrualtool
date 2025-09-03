import 'dotenv/config'
import express from 'express'
import bodyParser from 'body-parser'
import crypto from 'crypto'
import { XeroClient } from 'xero-node'

// Simple in-memory state (replace with DB if you productise)
const mem = {
  tenantId: '' as string,
  tokenInitialised: false,
  accrualByCampaign: new Map<string, number>(),
}

const scopes = [
  'offline_access',
  'accounting.settings',
  'accounting.transactions',
  'accounting.contacts',
]

const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID!,
  clientSecret: process.env.XERO_CLIENT_SECRET!,
  redirectUris: [process.env.XERO_REDIRECT_URI!],
  scopes,
})

async function requireTenant() {
  if (!mem.tokenInitialised) throw new Error('Connect to Xero first at /connect')
  if (!mem.tenantId) {
    const cons = await xero.updateTenants()
    mem.tenantId = cons[0]?.tenantId || ''
  }
  if (!mem.tenantId) throw new Error('No tenant connected')
  return mem.tenantId
}

const app = express()

// Raw body on webhook route for HMAC verification; JSON elsewhere
app.use('/webhooks/xero', bodyParser.raw({ type: '*/*' }))
app.use(bodyParser.json())

app.get('/', (_req, res) => res.send('Xero Media Accrual Plug-in is running.'))

// ---- OAuth connect/redirect ----
app.get('/connect', async (_req, res) => {
  const consentUrl = await xero.buildConsentUrl()
  res.redirect(consentUrl)
})

app.get('/callback', async (req, res) => {
  await xero.apiCallback(req.url)
  await xero.updateTenants()
  mem.tokenInitialised = true
  mem.tenantId = xero.tenants?.[0]?.tenantId || ''
  res.send('Connected to Xero. You can now POST /campaigns')
})

// ---- Utility ----
async function findTaxRateByName(name?: string) {
  if (!name) return undefined
  const tenantId = await requireTenant()
  const resp = await xero.accountingApi.getTaxRates(tenantId)
  const rates = resp.body.taxRates || []
  return rates.find(r => r.name?.toLowerCase() === name.toLowerCase())
}

// ---- Create campaign: invoice + accrual journal ----
app.post('/campaigns', async (req, res) => {
  try {
    const tenantId = await requireTenant()

    const {
      clientContactId,
      clientContactName,
      campaignRef,
      saleNet,
      expectedCostNet,
      dueDate,
      description,
      salesTaxName = process.env.SALES_TAX_NAME,
    } = req.body

    if (!campaignRef || saleNet == null || expectedCostNet == null || (!clientContactId && !clientContactName)) {
      return res.status(400).json({ error: 'Required: campaignRef, saleNet, expectedCostNet, clientContactId or clientContactName' })
    }

    // Ensure contact
    let contactId = clientContactId as string
    if (!contactId) {
      const newContact = await xero.accountingApi.createContacts(tenantId, { contacts: [{ name: clientContactName }] as any })
      contactId = newContact.body.contacts?.[0]?.contactID as string
    }

    // Sales invoice (authorised)
    const line: any = {
      description: description || `Media campaign ${campaignRef}`,
      quantity: 1,
      unitAmount: Number(saleNet),
      accountCode: process.env.MEDIA_REVENUE_CODE!,
    }
    if (salesTaxName) {
      const tax = await findTaxRateByName(salesTaxName)
      if (tax?.taxType) line.taxType = tax.taxType
    }
    const invResp = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [
        {
          type: 'ACCREC',
          contact: { contactID: contactId },
          date: new Date().toISOString().slice(0, 10),
          dueDate,
          status: 'AUTHORISED',
          reference: campaignRef,
          lineItems: [line],
        } as any,
      ],
    })
    const createdInvoice = invResp.body.invoices?.[0]

    // Accrual journal (Dr Media Costs, Cr Accrual Control) — no VAT on journals
    await xero.accountingApi.createManualJournals(tenantId, {
      manualJournals: [
        {
          narration: `Accrue expected media cost for ${campaignRef}`,
          date: new Date().toISOString().slice(0, 10),
          lineAmountTypes: 'Exclusive' as any,
          journalLines: [
            { accountCode: process.env.MEDIA_COST_CODE!, lineAmount: Number(expectedCostNet), description: `Accrued cost ${campaignRef}` },
            { accountCode: process.env.MEDIA_ACCRUAL_CONTROL_CODE!, lineAmount: -Number(expectedCostNet), description: `Accrued cost ${campaignRef}` },
          ],
        } as any,
      ],
    })

    mem.accrualByCampaign.set(campaignRef, (mem.accrualByCampaign.get(campaignRef) || 0) + Number(expectedCostNet))

    res.json({
      ok: true,
      invoiceNumber: createdInvoice?.invoiceNumber,
      invoiceId: createdInvoice?.invoiceID,
      campaignRef,
      accrued: expectedCostNet,
    })
  } catch (err: any) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ---- Webhook: recode draft supplier bills + variance journal ----
function verifyXeroWebhookSignature(signature: string, rawBody: Buffer) {
  const key = process.env.XERO_WEBHOOK_KEY
  if (!key) return false
  const hmac = crypto.createHmac('sha256', key)
  const digest = hmac.update(rawBody).digest('base64')
  try {
    return crypto.timingSafeEqual(Buffer.from(signature || ''), Buffer.from(digest))
  } catch {
    return false
  }
}

app.post('/webhooks/xero', async (req: any, res) => {
  try {
    const signature = req.headers['x-xero-signature'] as string || ''
    const rawBody: Buffer = req.body
    if (!verifyXeroWebhookSignature(signature, rawBody)) {
      return res.status(401).send('Invalid signature')
    }
    const json = JSON.parse(rawBody.toString('utf8'))
    const tenantId = await requireTenant()

    for (const ev of json.events || []) {
      if (ev.resourceType !== 'INVOICE') continue

      const invoiceId = ev.resourceId
      const invResp = await xero.accountingApi.getInvoice(tenantId, invoiceId)
      const inv: any = invResp.body.invoices?.[0]
      if (!inv) continue

      // Only supplier bills (ACCPAY) and only if editable
      if (inv.type !== 'ACCPAY') continue
      const status = String(inv.status || '')
      if (!(status === 'DRAFT' || status === 'SUBMITTED')) continue

      // CampaignRef from bill Reference (keep it simple)
      const campaignRef = inv.reference || ''
      if (!campaignRef) continue

      // Recode lines to Accrual Control (VAT remains on bill taxType)
      const accrualCode = process.env.MEDIA_ACCRUAL_CONTROL_CODE!
      const newLines = (inv.lineItems || []).map((li: any) => ({
        description: li.description,
        quantity: li.quantity,
        unitAmount: li.unitAmount,
        accountCode: accrualCode,
        taxType: li.taxType,
      }))

      await xero.accountingApi.updateInvoice(tenantId, invoiceId, { invoices: [{ lineItems: newLines } as any] })

      if ((process.env.AUTO_APPROVE_BILLS || 'true').toLowerCase() === 'true') {
        await xero.accountingApi.updateInvoice(tenantId, invoiceId, { invoices: [{ status: 'AUTHORISED' } as any] })
      }

      // Variance vs accrual
      const netBill = (newLines || []).reduce(
        (s: number, l: any) => s + Number(l.unitAmount || 0) * Number(l.quantity || 1),
        0
      )
      const accrued = mem.accrualByCampaign.get(campaignRef) || 0
      const variance = Number((netBill - accrued).toFixed(2))

      if (variance !== 0) {
        const costCode = process.env.MEDIA_COST_CODE!
        const jl =
          variance > 0
            ? [
                { accountCode: costCode, lineAmount: Math.abs(variance), description: `Accrual variance ${campaignRef}` },
                { accountCode: accrualCode, lineAmount: -Math.abs(variance), description: `Accrual variance ${campaignRef}` },
              ]
            : [
                { accountCode: accrualCode, lineAmount: Math.abs(variance), description: `Accrual release ${campaignRef}` },
                { accountCode: costCode, lineAmount: -Math.abs(variance), description: `Accrual release ${campaignRef}` },
              ]

        await xero.accountingApi.createManualJournals(tenantId, {
          manualJournals: [
            {
              narration: `Accrual variance for ${campaignRef}`,
              date: new Date().toISOString().slice(0, 10),
              lineAmountTypes: 'Exclusive' as any,
              journalLines: jl as any,
            } as any,
          ],
        })
      }
    }

    res.status(200).send('ok')
  } catch (err: any) {
    console.error(err)
    res.status(500).send(err.message)
  }
})

// ---- Boot ----
const port = Number(process.env.PORT || 3000)
app.listen(port, () => console.log(`Media Accrual Plug-in listening on ${port}`))
