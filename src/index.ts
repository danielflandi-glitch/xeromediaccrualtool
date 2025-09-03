import 'dotenv/config'
import express from 'express'
import bodyParser from 'body-parser'
import crypto from 'crypto'
import { XeroClient } from 'xero-node'

/** -----------------------------
 * In-memory state
 * ------------------------------*/
const mem = {
  tenantId: '' as string,
  tokenInitialised: false,
  accrualByCampaign: new Map<string, number>(),
  recent: [] as Array<{ ts: string; kind: 'ok' | 'err'; msg: string }>,
  settings: {
    revenueCode: process.env.MEDIA_REVENUE_CODE || '400',
    costCode: process.env.MEDIA_COST_CODE || '500',
    accrualCode: process.env.MEDIA_ACCRUAL_CONTROL_CODE || '850',
    salesTaxName: process.env.SALES_TAX_NAME || '20% (VAT on Income)',
    autoApproveBills: (process.env.AUTO_APPROVE_BILLS || 'true').toLowerCase() === 'true',
  },
}
function log(kind: 'ok' | 'err', msg: string) {
  mem.recent.unshift({ ts: new Date().toISOString(), kind, msg })
  mem.recent = mem.recent.slice(0, 20)
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
  if (!mem.tokenInitialised) throw new Error('Connect to Xero first
