import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import { XeroClient } from "xero-node";

/** -----------------------------
 * In-memory state
 * ------------------------------*/
const mem = {
  tenantId: "" as string,
  tokenInitialised: false,
  accrualByCampaign: new Map<string, number>(),
  recent: [] as Array<{ ts: string; kind: "ok" | "err"; msg: string }>,
  settings: {
    revenueCode: process.env.MEDIA_REVENUE_CODE || "400",
    costCode: process.env.MEDIA_COST_CODE || "500",
    accrualCode: process.env.MEDIA_ACCRUAL_CONTROL_CODE || "850",
    salesTaxName: process.env.SALES_TAX_NAME || "20% (VAT on Income)",
    autoApproveBills:
      (process.env.AUTO_APPROVE_BILLS || "true").toLowerCase() === "true",
  },
};

function log(kind: "ok" | "err", msg: string) {
  mem.recent.unshift({ ts: new Date().toISOString(), kind, msg });
  mem.recent = mem.recent.slice(0, 20);
}

const scopes = [
  "offline_access",
  "accounting.settings",
  "accounting.transactions",
  "accounting.contacts",
];

const xero = new XeroClient({
  clientId: process.env.XERO_CLIENT_ID!,
  clientSecret: process.env.XERO_CLIENT_SECRET!,
  redirectUris: [process.env.XERO_REDIRECT_URI!],
  scopes,
});

async function requireTenant() {
  if (!mem.tokenInitialised) throw new Error("Connect to Xero first at /connect");
  if (!mem.tenantId) {
    const cons = await xero.updateTenants();
    mem.tenantId = cons[0]?.tenantId || "";
  }
  if (!mem.tenantId) throw new Error("No tenant connected");
  return mem.tenantId;
}

const app = express();

// Raw body for webhook route; JSON & URL-encoded elsewhere
app.use("/webhooks/xero", bodyParser.raw({ type: "*/*" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/** -----------------------------
 * Health
 * ------------------------------*/
app.get("/", (_req, res) => res.send("Xero Media Accrual Plug-in is running."));

/** -----------------------------
 * OAuth connect / callback
 * ------------------------------*/
app.get("/connect", async (_req, res) => {
  const consentUrl = await xero.buildConsentUrl();
  res.redirect(consentUrl);
});

app.get("/callback", async (req, res) => {
  await xero.apiCallback(req.url);
  await xero.updateTenants();
  mem.tokenInitialised = true;
  mem.tenantId = xero.tenants?.[0]?.tenantId || "";
  log("ok", "Connected to Xero org.");
  res.redirect("/app");
});

/** -----------------------------
 * Helpers
 * ------------------------------*/
async function findTaxRateByName(name?: string) {
  if (!name) return undefined;
  const tenantId = await requireTenant();
  const resp = await xero.accountingApi.getTaxRates(tenantId);
  const rates = resp.body.taxRates || [];
  return rates.find((r) => (r.name || "").toLowerCase() === name.toLowerCase());
}

function verifyXeroWebhookSignature(signature: string, rawBody: Buffer) {
  const key = process.env.XERO_WEBHOOK_KEY;
  if (!key) return false;
  const hmac = crypto.createHmac("sha256", key);
  const digest = hmac.update(rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature || ""),
      Buffer.from(digest)
    );
  } catch {
    return false;
  }
}

/** -----------------------------
 * API: Settings
 * ------------------------------*/
app.get("/api/settings", (_req, res) => {
  res.json(mem.settings);
});

app.post("/api/settings", (req, res) => {
  const s = mem.settings;
  s.revenueCode = String(req.body.revenueCode || s.revenueCode);
  s.costCode = String(req.body.costCode || s.costCode);
  s.accrualCode = String(req.body.accrualCode || s.accrualCode);
  s.salesTaxName = String(req.body.salesTaxName || s.salesTaxName);
  s.autoApproveBills =
    String(req.body.autoApproveBills || s.autoApproveBills) === "true";
  log(
    "ok",
    `Settings updated: Rev ${s.revenueCode}, Cost ${s.costCode}, Accrual ${s.accrualCode}, VAT "${s.salesTaxName}", AutoApprove ${s.autoApproveBills}`
  );
  res.json({ ok: true });
});

/** -----------------------------
 * API: Create campaign (invoice + accrual)
 * ------------------------------*/
app.post("/campaigns", async (req, res) => {
  try {
    const tenantId = await requireTenant();
    const {
      clientContactId,
      clientContactName,
      campaignRef,
      saleNet,
      expectedCostNet,
      dueDate,
      description,
      salesTaxName,
    } = req.body;

    if (
      !campaignRef ||
      saleNet == null ||
      expectedCostNet == null ||
      (!clientContactId && !clientContactName)
    ) {
      return res.status(400).json({
        error:
          "Required: campaignRef, saleNet, expectedCostNet, clientContactId or clientContactName",
      });
    }

    // Ensure contact
    let contactId = clientContactId as string;
    if (!contactId) {
      const newContact = await xero.accountingApi.createContacts(tenantId, {
        contacts: [{ name: clientContactName }] as any,
      });
      contactId = newContact.body.contacts?.[0]?.contactID as string;
    }

    // Invoice
    const line: any = {
      description: description || `Media campaign ${campaignRef}`,
      quantity: 1,
      unitAmount: Number(saleNet),
      accountCode: mem.settings.revenueCode,
    };
    const taxName = salesTaxName || mem.settings.salesTaxName;
    if (taxName) {
      const tax = await findTaxRateByName(taxName);
      if (tax?.taxType) line.taxType = tax.taxType;
    }
    const invResp = await xero.accountingApi.createInvoices(tenantId, {
      invoices: [
        {
          type: "ACCREC",
          contact: { contactID: contactId },
          date: new Date().toISOString().slice(0, 10),
          dueDate,
          status: "AUTHORISED",
          reference: campaignRef,
          lineItems: [line],
        } as any,
      ],
    });
    const createdInvoice = invResp.body.invoices?.[0];

    // Accrual journal (no VAT)
    await xero.accountingApi.createManualJournals(tenantId, {
      manualJournals: [
        {
          narration: `Accrue expected media cost for ${campaignRef}`,
          date: new Date().toISOString().slice(0, 10),
          lineAmountTypes: "Exclusive" as any,
          journalLines: [
            {
              accountCode: mem.settings.costCode,
              lineAmount: Number(expectedCostNet),
              description: `Accrued cost ${campaignRef}`,
            },
            {
              accountCode: mem.settings.accrualCode,
              lineAmount: -Number(expectedCostNet),
              description: `Accrued cost ${campaignRef}`,
            },
          ],
        } as any,
      ],
    });

    mem.accrualByCampaign.set(
      campaignRef,
      (mem.accrualByCampaign.get(campaignRef) || 0) + Number(expectedCostNet)
    );
    const msg = `Created invoice ${
      createdInvoice?.invoiceNumber || ""
    } and accrued £${Number(expectedCostNet).toFixed(2)} for ${campaignRef}`;
    log("ok", msg);

    res.json({
      ok: true,
      invoiceNumber: createdInvoice?.invoiceNumber,
      invoiceId: createdInvoice?.invoiceID,
      campaignRef,
      accrued: Number(expectedCostNet),
      message: msg,
    });
  } catch (err: any) {
    log("err", `Create campaign failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/** -----------------------------
 * Webhook: recode draft supplier bills + variance journal
 * ------------------------------*/
app.post("/webhooks/xero", async (req: any, res) => {
  try {
    const signature = (req.headers["x-xero-signature"] as string) || "";
    const rawBody: Buffer = req.body;
    if (!verifyXeroWebhookSignature(signature, rawBody))
      return res.status(401).send("Invalid signature");

    const json = JSON.parse(rawBody.toString("utf8"));
    const tenantId = await requireTenant();

    for (const ev of json.events || []) {
      if (ev.resourceType !== "INVOICE") continue;

      const invoiceId = ev.resourceId;
      const invResp = await xero.accountingApi.getInvoice(tenantId, invoiceId);
      const inv: any = invResp.body.invoices?.[0];
      if (!inv) continue;
      if (inv.type !== "ACCPAY") continue;

      const status = String(inv.status || "");
      if (!(status === "DRAFT" || status === "SUBMITTED")) continue;

      const campaignRef = inv.reference || "";
      if (!campaignRef) continue;

      // Recode lines to Accrual Control (VAT remains on bill line)
      const newLines = (inv.lineItems || []).map((li: any) => ({
        description: li.description,
        quantity: li.quantity,
        unitAmount: li.unitAmount,
        accountCode: mem.settings.accrualCode,
        taxType: li.taxType,
      }));
      await xero.accountingApi.updateInvoice(tenantId, invoiceId, {
        invoices: [{ lineItems: newLines } as any],
      });

      if (mem.settings.autoApproveBills) {
        await xero.accountingApi.updateInvoice(tenantId, invoiceId, {
          invoices: [{ status: "AUTHORISED" } as any],
        });
      }

      // Variance vs accrual
      const netBill = (newLines || []).reduce(
        (s: number, l: any) =>
          s + Number(l.unitAmount || 0) * Number(l.quantity || 1),
        0
      );
      const accrued = mem.accrualByCampaign.get(campaignRef) || 0;
      const variance = Number((netBill - accrued).toFixed(2));

      if (variance !== 0) {
        const jl =
          variance > 0
            ? [
                {
                  accountCode: mem.settings.costCode,
                  lineAmount: Math.abs(variance),
                  description: `Accrual variance ${campaignRef}`,
                },
                {
                  accountCode: mem.settings.accrualCode,
                  lineAmount: -Math.abs(variance),
                  description: `Accrual variance ${campaignRef}`,
                },
              ]
            : [
                {
                  accountCode: mem.settings.accrualCode,
                  lineAmount: Math.abs(variance),
                  description: `Accrual release ${campaignRef}`,
                },
                {
                  accountCode: mem.settings.costCode,
                  lineAmount: -Math.abs(variance),
                  description: `Accrual release ${campaignRef}`,
                },
              ];

        await xero.accountingApi.createManualJournals(tenantId, {
          manualJournals: [
            {
              narration: `Accrual variance for ${campaignRef}`,
              date: new Date().toISOString().slice(0, 10),
              lineAmountTypes: "Exclusive" as any,
              journalLines: jl as any,
            } as any,
          ],
        });
      }

      log(
        "ok",
        `Bill ${inv.invoiceNumber || inv.invoiceID} recoded to accrual; variance £${variance.toFixed(
          2
        )} for ${campaignRef}`
      );
    }

    res.status(200).send("ok");
  } catch (err: any) {
    log("err", `Webhook error: ${err.message}`);
    res.status(500).send(err.message);
  }
});

/** -----------------------------
 * Ultra-simple UI at /app
 * ------------------------------*/
const appHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Media Accrual Plug-in</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell; margin: 0; background: #0b1020; color: #e5e7eb; }
    .wrap { max-width: 980px; margin: 24px auto; padding: 0 16px; }
    .banner { background:#111827; border:1px solid #1f2937; padding:12px 16px; border-radius:12px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center; }
    a.btn, button.btn { background:#2563eb; color:white; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; text-decoration:none; }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .card { background:#111827; border:1px solid #1f2937; border-radius:12px; padding:16px; }
    label { display:block; font-size:14px; margin:8px 0 4px; color:#cbd5e1; }
    input, select, textarea { width:100%; padding:8px; border-radius:8px; border:1px solid #334155; background:#0f172a; color:#e5e7eb; }
    .muted { color:#94a3b8; font-size:12px; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
    .ok { color:#10b981; }
    .err { color:#ef4444; }
    pre { white-space: pre-wrap; word-wrap: break-word; background:#0f172a; padding:8px; border-radius:8px; border:1px solid #334155; }
    ul.logs { list-style:none; padding:0; margin:0; }
    ul.logs li{ padding:6px 0; border-bottom:1px dashed #334155; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="banner">
      <div>
        <strong>Media Accrual Plug-in</strong>
        <div class="muted">Create sales + accruals. Bills recode via webhooks.</div>
      </div>
      <div>
        <a class="btn" href="/connect">Connect to Xero</a>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Settings</h3>
        <form id="settings">
          <div class="row">
            <div>
              <label>Revenue account code</label>
              <input name="revenueCode" required>
            </div>
            <div>
              <label>Media cost account code</label>
              <input name="costCode" required>
            </div>
          </div>
          <div class="row">
            <div>
              <label>Accrual control account code</label>
              <input name="accrualCode" required>
            </div>
            <div>
              <label>Sales VAT name (as in Xero)</label>
              <input name="salesTaxName" required>
            </div>
          </div>
          <div style="margin:8px 0;">
            <label><input type="checkbox" name="autoApproveBills"> Auto-approve supplier bills after recoding</label>
          </div>
          <button class="btn" type="submit">Save settings</button>
          <div id="sOut" class="muted" style="margin-top:8px;"></div>
        </form>
      </div>

      <div class="card">
        <h3>Create Campaign</h3>
        <form id="campaign">
          <label>Client name</label>
          <input name="clientContactName" placeholder="Acme Marketing" required>
          <label>Campaign ref (will also be used as bill Reference)</label>
          <input name="campaignRef" placeholder="SEPT-PAID-SOCIAL" required>
          <div class="row">
            <div>
              <label>Sale (net)</label>
              <input name="saleNet" type="number" step="0.01" value="10000" required>
            </div>
            <div>
              <label>Expected cost (net)</label>
              <input name="expectedCostNet" type="number" step="0.01" value="8000" required>
            </div>
          </div>
          <div class="row">
            <div>
              <label>Due date (YYYY-MM-DD)</label>
              <input name="dueDate" placeholder="2025-09-30">
            </div>
            <div>
              <label>Description</label>
              <input name="description" placeholder="September social ads">
            </div>
          </div>
          <button class="btn" type="submit">Create campaign</button>
          <pre id="cOut" class="muted" style="margin-top:8px;"></pre>
        </form>
        <div class="muted" style="margin-top:8px;">
          Tip: when supplier bills arrive, put the same text in the <strong>Reference</strong> field
          (e.g. <em>SEPT-PAID-SOCIAL</em>). The plugin will recode and handle variances.
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <h3>Recent activity</h3>
      <ul class="logs" id="logs"></ul>
    </div>
  </div>
  <script>
    async function loadSettings() {
      const r = await fetch('/api/settings'); const s = await r.json();
      const f = document.getElementById('settings');
      (f.querySelector('[name="revenueCode"]')).value = s.revenueCode;
      (f.querySelector('[name="costCode"]')).value = s.costCode;
      (f.querySelector('[name="accrualCode"]')).value = s.accrualCode;
      (f.querySelector('[name="salesTaxName"]')).value = s.salesTaxName;
      (f.querySelector('[name="autoApproveBills"]')).checked = !!s.autoApproveBills;
    }
    async function saveSettings(e) {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd.entries());
      data.autoApproveBills = String(fd.get('autoApproveBills') !== null);
      const r = await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
      document.getElementById('sOut').textContent = r.ok ? 'Settings saved.' : 'Save failed.';
      loadLogs();
    }
    async function createCampaign(e) {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd.entries());
      data.saleNet = Number(data.saleNet);
      data.expectedCostNet = Number(data.expectedCostNet);
      const r = await fetch('/campaigns', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
      const txt = await r.text();
      document.getElementById('cOut').textContent = txt;
      loadLogs();
    }
    async function loadLogs() {
      const r = await fetch('/api/logs'); const items = await r.json();
      const ul = document.getElementById('logs'); ul.innerHTML = '';
      for (const it of items) {
        const li = document.createElement('li');
        li.innerHTML = '<span class=\"'+(it.kind)+'\">['+it.kind.toUpperCase()+']</span> '+new Date(it.ts).toLocaleString()+' — '+it.msg;
        ul.appendChild(li);
      }
    }
    document.getElementById('settings').addEventListener('submit', saveSettings);
    document.getElementById('campaign').addEventListener('submit', createCampaign);
    loadSettings(); loadLogs();
  </script>
</body>
</html>`;
app.get("/ap
