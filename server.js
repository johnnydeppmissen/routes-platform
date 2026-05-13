require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

let db = null;

const ROUTE_NAMES = [
  'Shortlinks', 'Armatel', 'MMD', 'Sempico', 'SMSEdge',
  'Telecom23', 'Vacotel', 'Lexico Clickmil', 'Lexico Clickbil',
  'SMS Warriors', 'Laaffic', 'BOE Emre', 'Dynamic Messaging',
  'Numedo', 'Xeebi', 'GoMobit'
];

function requireAuth(req, res, next) {
  if (!process.env.AUTH_PASSWORD) return next();
  if (req.headers['x-auth-token'] === process.env.AUTH_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

async function calculateBalance(routeId) {
  const route = await db.collection('routes').findOne({ _id: new ObjectId(routeId) });
  if (!route) return null;
  const events = await db.collection('events')
    .find({ routeId: new ObjectId(routeId) })
    .sort({ date: 1 })
    .toArray();

  // Use the most recent balance_update as the anchor (confirmed by the route)
  // Only top-ups after that anchor affect the calculated balance.
  // Monthly reports are stored for reference/reconciliation but do NOT change the calculation.
  const lastConfirmed = [...events].reverse().find(e => e.type === 'balance_update');
  if (lastConfirmed) {
    let bal = lastConfirmed.reportedBalanceEur || 0;
    for (const e of events) {
      if (new Date(e.date) > new Date(lastConfirmed.date) && e.type === 'topup') {
        bal += e.eurAmount || 0;
      }
    }
    return Math.round(bal * 100) / 100;
  }

  // No balance updates yet — fall back to baseline + top-ups only
  if (route.baselineBalance == null) return null;
  const baselineDate = route.baselineDate ? new Date(route.baselineDate) : new Date(0);
  let bal = route.baselineBalance;
  for (const e of events) {
    if (new Date(e.date) > baselineDate && e.type === 'topup') {
      bal += e.eurAmount || 0;
    }
  }
  return Math.round(bal * 100) / 100;
}

// Reconciliation: for a monthly report event, find the two balance updates
// that bracket that month and calculate implied spend vs reported spend.
// Implied spend = start_balance + top-ups_in_period - end_balance
function calcReconciliation(events, reportEvent) {
  if (!reportEvent.month) return null;
  const [year, month] = reportEvent.month.split('-').map(Number);
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd   = new Date(year, month, 1);       // first day of NEXT month

  const balUpdates = events
    .filter(e => e.type === 'balance_update')
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // Start: most recent balance update at or before the last day of this month
  const startUpdate = [...balUpdates]
    .filter(e => new Date(e.date) < monthEnd)
    .pop();

  // End: first balance update on or after the first day of next month
  const endUpdate = balUpdates
    .find(e => new Date(e.date) >= monthEnd);

  if (!startUpdate || !endUpdate) return null;

  // Top-ups strictly between startUpdate and endUpdate dates
  const topupsTotal = events
    .filter(e => e.type === 'topup' &&
                 new Date(e.date) > new Date(startUpdate.date) &&
                 new Date(e.date) <= new Date(endUpdate.date))
    .reduce((sum, e) => sum + (e.eurAmount || 0), 0);

  const impliedSpend  = Math.round((startUpdate.reportedBalanceEur + topupsTotal - endUpdate.reportedBalanceEur) * 100) / 100;
  const reportedSpend = Math.round((reportEvent.eurAmount || 0) * 100) / 100;
  const diff          = Math.round((impliedSpend - reportedSpend) * 100) / 100;

  return {
    startBalance:  startUpdate.reportedBalanceEur,
    startDate:     startUpdate.date,
    endBalance:    endUpdate.reportedBalanceEur,
    endDate:       endUpdate.date,
    topupsTotal:   Math.round(topupsTotal * 100) / 100,
    impliedSpend,
    reportedSpend,
    diff,
    isReconciled: Math.abs(diff) < 1   // within €1 tolerance
  };
}

// Calculate what the balance SHOULD have been at a given date.
// Used to verify balance updates: expected vs what the route reported.
function calcExpectedAtDate(route, events, targetDate, excludeId) {
  const tgt = new Date(targetDate).getTime();
  const prevConfirmed = [...events]
    .filter(e => e.type === 'balance_update' &&
                 new Date(e.date).getTime() < tgt &&
                 e._id.toString() !== (excludeId || '').toString())
    .pop();

  let anchor, anchorTime;
  if (prevConfirmed) {
    anchor = prevConfirmed.reportedBalanceEur || 0;
    anchorTime = new Date(prevConfirmed.date).getTime();
  } else if (route.baselineBalance != null) {
    anchor = route.baselineBalance;
    anchorTime = route.baselineDate ? new Date(route.baselineDate).getTime() : 0;
  } else {
    return null;
  }

  let bal = anchor;
  for (const e of events) {
    const t = new Date(e.date).getTime();
    if (t > anchorTime && t <= tgt && e.type === 'topup') {
      bal += e.eurAmount || 0;
    }
  }
  return Math.round(bal * 100) / 100;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  if (!process.env.AUTH_PASSWORD || req.body.password === process.env.AUTH_PASSWORD) {
    res.json({ token: process.env.AUTH_PASSWORD || 'open' });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/routes', requireAuth, async (req, res) => {
  try {
    const routes = await db.collection('routes').find().sort({ name: 1 }).toArray();
    const result = await Promise.all(routes.map(async r => {
      const events = await db.collection('events')
        .find({ routeId: r._id }).sort({ date: 1 }).toArray();
      const calc = await calculateBalance(r._id);
      const lastUpdate = [...events].reverse().find(e => e.type === 'balance_update');
      const lastTopup  = [...events].reverse().find(e => e.type === 'topup');
      // Discrepancy only comes from monthly reconciliation — NOT from balance updates
      const lastReport = [...events].reverse().find(e => e.type === 'monthly_report' && e.month);
      let discrepancy = null;
      if (lastReport) {
        const recon = calcReconciliation(events, lastReport);
        if (recon && !recon.isReconciled) discrepancy = recon.diff;
      }
      return {
        ...r,
        calculatedBalance: calc,
        lastReportedBalance: lastUpdate?.reportedBalanceEur ?? null,
        lastReportedDate: lastUpdate?.date ?? null,
        discrepancy,
        lastTopupDate: lastTopup?.date ?? null
      };
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/routes/:id', requireAuth, async (req, res) => {
  try {
    const r = await db.collection('routes').findOne({ _id: new ObjectId(req.params.id) });
    if (!r) return res.status(404).json({ error: 'Not found' });
    const events = await db.collection('events')
      .find({ routeId: r._id }).sort({ date: 1 }).toArray();
    const calc = await calculateBalance(r._id);
    const lastUpdate = [...events].reverse().find(e => e.type === 'balance_update');
    const lastReport = [...events].reverse().find(e => e.type === 'monthly_report' && e.month);
    let discrepancy = null;
    if (lastReport) {
      const recon = calcReconciliation(events, lastReport);
      if (recon && !recon.isReconciled) discrepancy = recon.diff;
    }
    res.json({
      ...r,
      calculatedBalance: calc,
      lastReportedBalance: lastUpdate?.reportedBalanceEur ?? null,
      lastReportedDate: lastUpdate?.date ?? null,
      discrepancy
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/routes/:id', requireAuth, async (req, res) => {
  try {
    const { currency, creditLimit, paymentMethods, isActive, baselineBalance, baselineDate, notes } = req.body;
    await db.collection('routes').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: {
        currency: currency || 'EUR',
        creditLimit: parseFloat(creditLimit) || 0,
        paymentMethods: paymentMethods || [],
        isActive: isActive !== false,
        baselineBalance: parseFloat(baselineBalance) || 0,
        baselineDate: baselineDate ? new Date(baselineDate) : new Date(),
        notes: notes || '',
        isSetup: true,
        updatedAt: new Date()
      }}
    );
    res.json(await db.collection('routes').findOne({ _id: new ObjectId(req.params.id) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Events ────────────────────────────────────────────────────────────────────

app.get('/api/routes/:id/events', requireAuth, async (req, res) => {
  try {
    const route = await db.collection('routes').findOne({ _id: new ObjectId(req.params.id) });
    const events = await db.collection('events')
      .find({ routeId: new ObjectId(req.params.id) })
      .sort({ date: 1 })
      .toArray();
    // Enrich events with useful context
    const enriched = events.map(e => {
      if (e.type === 'balance_update') {
        // Show change since previous balance update (informational only — not a discrepancy)
        const prevUpdate = [...events]
          .filter(ev => ev.type === 'balance_update' && new Date(ev.date) < new Date(e.date))
          .pop();
        const changeFromPrevious = prevUpdate
          ? Math.round(((e.reportedBalanceEur || 0) - (prevUpdate.reportedBalanceEur || 0)) * 100) / 100
          : null;
        return { ...e, changeFromPrevious };
      }
      if (e.type === 'monthly_report') {
        const recon = calcReconciliation(events, e);
        return { ...e, reconciliation: recon };
      }
      return e;
    });
    res.json(enriched.reverse()); // newest first for display
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/events', requireAuth, async (req, res) => {
  try {
    const doc = {
      ...req.body,
      routeId: new ObjectId(req.body.routeId),
      date: new Date(req.body.date),
      eurAmount: parseFloat(req.body.eurAmount) || 0,
      createdAt: new Date()
    };
    if (doc.originalAmount !== undefined) doc.originalAmount = parseFloat(doc.originalAmount);
    if (doc.reportedBalanceEur !== undefined) doc.reportedBalanceEur = parseFloat(doc.reportedBalanceEur);
    if (doc.reportedBalance !== undefined) doc.reportedBalance = parseFloat(doc.reportedBalance);
    const r = await db.collection('events').insertOne(doc);
    res.json({ ...doc, _id: r.insertedId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  try {
    await db.collection('events').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/routes/:id/reset', requireAuth, async (req, res) => {
  try {
    await db.collection('routes').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $unset: { currency: '', creditLimit: '', paymentMethods: '', isActive: '', baselineBalance: '', baselineDate: '', notes: '' },
        $set: { isSetup: false, updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Files ─────────────────────────────────────────────────────────────────────

app.get('/api/routes/:id/files', requireAuth, async (req, res) => {
  try {
    const files = await db.collection('files')
      .find({ routeId: new ObjectId(req.params.id) }, { projection: { data: 0 } })
      .sort({ date: -1 })
      .toArray();
    res.json(files);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/routes/:id/files', requireAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const doc = {
      routeId: new ObjectId(req.params.id),
      originalName: req.file.originalname,
      fileCategory: req.body.fileCategory || 'other',
      month: req.body.month || null,
      date: req.body.date ? new Date(req.body.date) : new Date(),
      data: req.file.buffer.toString('base64'),
      mimeType: req.file.mimetype,
      size: req.file.size,
      notes: req.body.notes || '',
      createdAt: new Date()
    };
    const r = await db.collection('files').insertOne(doc);
    const { data, ...withoutData } = doc;
    res.json({ ...withoutData, _id: r.insertedId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files/:id', requireAuth, async (req, res) => {
  try {
    const file = await db.collection('files').findOne({ _id: new ObjectId(req.params.id) });
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition',
      `${req.query.dl === '1' ? 'attachment' : 'inline'}; filename="${file.originalName}"`);
    res.send(Buffer.from(file.data, 'base64'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  try {
    await db.collection('files').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────────────

MongoClient.connect(process.env.MONGODB_URI).then(async client => {
  db = client.db('routes-platform');
  for (const name of ROUTE_NAMES) {
    await db.collection('routes').updateOne(
      { name },
      { $setOnInsert: { name, isSetup: false, createdAt: new Date() } },
      { upsert: true }
    );
  }
  app.listen(PORT, () => console.log(`Routes Platform running on port ${PORT}`));
}).catch(e => { console.error('DB connection failed:', e.message); process.exit(1); });
