import 'dotenv/config'
import express from 'express'
import bodyParser from 'body-parser'
import crypto from 'crypto'
import { XeroClient } from 'xero-node'

// ------------------
// In-memory store (replace with DB in production)
// ------------------
const mem = {
  tenantId: '' as string,
  tokenInitialised: false,
  accrualByCampaign: new Map<string, number>()
}

const scopes = [
  'offline_access',
  'accounting.settings',
  'accounting.transactions',
  'accounting.contacts'
]

const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID!,
  clientSecret: process.env.XERO_CLIENT_SECRET!,
  redirectUris: [process.env.XERO_REDIRECT_URI!],
  scopes
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

// Capture raw body for webhook signature validation
app.use('/webhooks/xero', bodyParser.raw({ type: '*/*' }))
app.use(bodyParser.json())

app.get('/', (_req, res) => res.send('Xero Media Accrual Plug-in is running.'))

// OAuth connection flow
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

// Utility: find tax rate by name
async function findTaxRateByName(name?: string) {
  if (!name) return undefined
  const tenantId = await requireTenant()
  const resp = await xero.accountingApi.getTaxRates(tenantId)
  const rates = resp.body.taxRates || []
  return rates.find(r => r.name?.toLowerCase() === name.toLowerCase())
}

// Utility: ensure accounts exist
async function upsertAccount(code: string, name: string, type: 'REVENUE'|'EXPENSE'|'CURRLIAB', taxName?: string) {
  const tenantId = await requireTenant()
  const api = xero.accountingApi
  const existing = await api.getAccounts(tenantId)
  const found = existing.body.accounts?.find(a => a.code === code)
  if (found) return found
  const account: any = { code, name, type, enablePaymentsToAccount: false }
  if (taxName) {
    const tax = await findTaxRateByName(taxName)
    if (tax?.taxType) account.taxType = tax.taxType
  }
  const created = await api.createAccount(tenantId, { accounts: [account] })
  return created.body.accounts?.[0]
}

async function ensureCoreSetup() {
  await upsertAccount(process.env.MEDIA_REVENUE_CODE!, 'Media Revenue', 'REVENUE', process.env.SALES_TAX_NAME)
  await upsertAccount(process.env.MEDIA_COST_CODE!, 'Media Costs', 'EXPENSE', process.env.PURCHASE_TAX_NAME)
  await upsertAccount(process.env.MEDIA_ACCRUAL_CONTROL_CODE!, 'Media Accrual Control', 'CURRLIAB')
}

// Utility: ensure tracking category + option exists
async function ensureCampaignTracking(campaignRef: string) {
  const tenantId = await requireTenant()
  const api = xero.accountingApi
  const cats = await api.getTrackingCategories(tenantId)
  let campaignCat = cats.body.trackingCategories?.find(c => c.name === 'Campaign' && c.status === 'ACTIVE')
  if (!campaignCat) {
    const created = await api.createTrackingCategory(tenantId, { trackingCategories: [{ name: 'Campaign' }] })
    campaignCat = created.body.trackingCategories?.[0]
  }
  const opt = campaignCat?.options?.find(o => o.name === campaignRef && o.status === 'ACTIVE')
  if (!opt) {
    const createdOpt = await api.createTrackingOptions(tenantId, campaignCat!.trackingCategoryID!, { trackingOptions: [{ name: campaignRef }] })
    return { category: campaignCat!, option: createdOpt.body.options?.[0] }
  }
  return { category: campaignCat!, option: opt }
}

// ------------------
// POST /campaigns
// ------------------
app.post('/campaigns', async (req, res) => {
  try {
    const tenantId = await requireTenant()
    await ensureCoreSetup()

    const {
      clientContactId,
      clientContactName,
      campaignRef,
      saleNet,
      expectedCostNet,
      dueDate,
      description,
      salesTaxName = process.env.SALES_TAX_NAME
    } = req.body

    if (!campaignRef || saleNet == null || expectedCostNet == null || (!clientContactId && !clientContactName)) {
      return res.status(400).json({ error: 'Required: campaignRef, saleNet, expectedCostNet, clientContactId or clientContactName' })
    }

    const { category, option } = await ensureCampaignTracking(campaignRef)
    let contactId = clientContactId as string
    if (!contactId) {
      const newContact = await xero.accountingApi.createContacts(tenantId, { contacts: [{ name: clientContactName }] })
      contactId = newContact.body.contacts?.[0]?.contactID as string
    }
    const tracking = [{ trackingCategoryID: category.trackingCategoryID!, name: 'Campaign', option: option?.name || campaignRef }]

    // Sales invoice
    const line: any = {
      description: description || `Media campaign ${campaignRef}`,
      quantity: 1,
      unitAmount: saleNet,
      accountCode: process.env.MEDIA_REVENUE_CODE!,
      tracking
    }
    if (salesTaxName) {
      const tax = await findTaxRateByName(salesTaxName)
      if (tax?.taxType) line.taxType = tax.taxType
    }
    const invResp = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [{
        type: 'ACCREC',
        contact: { contactID: contactId },
        date: new Date().toISOString().slice(0,10),
        dueDate,
        status: 'AUTHORISED',
        reference: campaignRef,
        lineItems: [line]
      }]
    })
    const createdInvoice = invResp.body.invoices?.[0]

    // Manual journal for accrual
    await xero.accountingApi.createManualJournals(tenantId, {
      manualJournals: [{
        narration: `Accrue expected media cost for ${campaignRef}`,
        date: new Date().toISOString().slice(0,10),
        lineAmountTypes: 'Exclusive',
        journalLines: [
          { accountCode: process.env.MEDIA_COST_CODE!, lineAmount: Number(expectedCostNet), description: `Accrued cost ${campaignRef}`, tracking },
          { accountCode: process.env.MEDIA_ACCRUAL_CONTROL_CODE!, lineAmount: -Number(expectedCostNet), description: `Accrued cost ${campaignRef}`, tracking }
        ]
      }]
    })

    mem.accrualByCampaign.set(campaignRef, (mem.accrualByCampaign.get(campaignRef) || 0) + Number(expectedCostNet))

    res.json({
      ok: true,
      invoiceNumber: createdInvoice?.invoiceNumber,
      invoiceId: createdInvoice?.invoiceID,
      campaignRef,
      accrued: expectedCostNet
    })
  } catch (err: any) {
    console.error(err)
    res.status(500).json({ error: err.message })
  }
})

// ------------------
// Webhook handler
// ------------------
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
      const inv = invResp.body.invoices?.[0]
      if (!inv) continue
      if (inv.type !== 'ACCPAY') continue
      if (!['DRAFT','SUBMITTED'].includes(String(inv.status))) continue

      const campaignRef = inv.reference || inv.lineItems?.[0]?.tracking?.find((t:any) => t.name === 'Campaign')?.option
      if (!campaignRef) continue

      const { category, option } = await ensureCampaignTracking(campaignRef)
      const tracking = [{ trackingCategoryID: category.trackingCategoryID!, name: 'Campaign', option: option?.name || campaignRef }]
      const accrualCode = process.env.MEDIA_ACCRUAL_CONTROL_CODE!

      const newLines = (inv.lineItems || []).map((li:any) => ({
        description: li.description,
        quantity: li.quantity,
        unitAmount: li.unitAmount,
        accountCode: accrualCode,
        taxType: li.taxType,
        tracking
      }))

      await xero.accountingApi.updateInvoice(tenantId, invoiceId, { invoices: [{ lineItems: newLines }] })

      if ((process.env.AUTO_APPROVE_BILLS || 'true').toLowerCase() === 'true') {
        await xero.accountingApi.updateInvoice(tenantId, invoiceId, { invoices: [{ status: 'AUTHORISED' }] })
      }

      const netBill = (newLines || []).reduce((s:number, l:any) => s + Number(l.unitAmount || 0) * Number(l.quantity || 1), 0)
      const accrued = mem.accrualByCampaign.get(campaignRef) || 0
      const variance = Number((netBill - accrued).toFixed(2))

      if (variance !== 0) {
        const costCode = process.env.MEDIA_COST_CODE!
        const jl = variance > 0
          ? [
              { accountCode: costCode, lineAmount: Math.abs(variance), description: `Accrual variance ${campaignRef}`, tracking },
              { accountCode: accrualCode, lineAmount: -Math.abs(variance), description: `Accrual variance ${campaignRef}`, tracking }
            ]
          : [
              { accountCode: accrualCode, lineAmount: Math.abs(variance), description: `Accrual release ${campaignRef}`, tracking },
              { accountCode: costCode, lineAmount: -Math.abs(variance), description: `Accrual release ${campaignRef}`, tracking }
            ]
        await xero.accountingApi.createManualJournals(tenantId, {
          manualJournals: [{
            narration: `Accrual variance for ${campaignRef}`,
            date: new Date().toISOString().slice(0,10),
            lineAmountTypes: 'Exclusive',
            journalLines: jl
          }]
        })
      }
    }

    res.status(200).send('ok')
  } catch (err: any) {
    console.error(err)
    res.status(500).send(err.message)
  }
})

// ------------------
// Boot server
// ------------------
const port = Number(process.env.PORT || 3000)
app.listen(port, () => console.log(`Media Accrual Plug-in listening on ${port}`))
