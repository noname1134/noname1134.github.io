// Refactored booking server implementing working-hours, physical vs digital services,
// kidud duration & conflict rules, auto-scheduling for digital services.
//
// Usage: node server.js
// Requires: npm install express cors sqlite3 body-parser luxon
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const { DateTime, Duration } = require('luxon');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'appointments.db');

app.use(cors());
app.use(bodyParser.json());

// Open DB and ensure table exists
const db = new sqlite3.Database(DB_FILE);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serviceType TEXT,
    details TEXT,
    startTime TEXT,
    endTime TEXT,
    created_at TEXT,
    phone TEXT,
    done BOOLEAN DEFAULT 0
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_start ON appointments(startTime)`);
});

// WORKING HOURS blocks (local time Asia/Jerusalem)
const WORKING_BLOCKS = [
  { start: '08:30', end: '11:30' },
  { start: '16:30', end: '18:30' },
  { start: '20:30', end: '22:00' }
];
const SLOT_STEP_MIN = 5; // 5-minute granularity

// Helper: parse details safely
function parseDetails(details) {
  if (!details) return {};
  if (typeof details === 'string') {
    try { return JSON.parse(details || '{}'); } catch(e){ return {}; }
  }
  return details;
}

// Compute duration (minutes) by serviceType + details
function computeDuration(serviceType, details) {
  const st = (serviceType || '').toString().trim().toLowerCase();
  details = parseDetails(details || {});

  // Kidud rules: 10 minutes per unit. Total duration = Math.max(numS*10, numA*10) with min 10
  if (st === 'kidud' || st.includes('kidud') || st.includes('קידוד')) {
    const numS = parseInt(details.sodi || details.numS || 0, 10) || 0;
    const numA = parseInt(details.anan || details.numA || 0, 10) || 0;
    const sMinutes = numS * 10;
    const aMinutes = numA * 10;
    const maxMinutes = Math.max(sMinutes, aMinutes);
    return Math.max(maxMinutes, 10);
  }

  // Map other services to durations
  const map = {
    "אישור הוצל\"א": 15,
    "השחרה": 15,
    "טיולים יוצא": 5,
    "טופס טיולים - יוצא": 5,
    "חו\"ל": 5,
    "טופס חו\"ל": 5,
    "אישור כניסה קבוע": 5,
    // english keys:
    "hotzla": 15,
    "hashchara": 15,
    "tiulim-out": 5,
    "chul": 5
  };

  if (map[serviceType]) return map[serviceType];
  const low = st;
  for (const k of Object.keys(map)) {
    if (k.toString().toLowerCase() === low) return map[k];
  }
  return 5;
}

function checkConflicts(startISO, endISO, serviceType, details) {
  return new Promise((resolve, reject) => {
    db.all(`SELECT * FROM appointments WHERE NOT (endTime <= ? OR startTime >= ?)`, [startISO, endISO], (err, rows) => {
      if (err) return reject(err);
      if (rows.length >= 2) return resolve({ ok: false, message: 'במועד זה כבר קיימים שני תורים חופפים' });

      const st = (serviceType || '').toString().trim().toLowerCase();
      const isKidud = (st === 'kidud' || st.includes('kidud') || st.includes('קידוד'));
      if (isKidud) {
        const d = parseDetails(details || {});
        const newS = parseInt(d.sodi || d.numS || 0, 10) || 0;
        const newA = parseInt(d.anan || d.numA || 0, 10) || 0;

        for (const r of rows) {
          const rs = (r.serviceType || '').toString().trim().toLowerCase();
          if (rs === 'kidud' || rs.includes('kidud') || rs.includes('קידוד')) {
            let existing = {};
            try { existing = JSON.parse(r.details || '{}'); } catch(e){ existing = {}; }
            const rS = parseInt(existing.sodi || existing.numS || 0, 10) || 0;
            const rA = parseInt(existing.anan || existing.numA || 0, 10) || 0;
            if (newS > 0 && rS > 0) return resolve({ ok: false, message: 'לא ניתן לקבוע שני קידודים על אותה רשת סודי/סודי ביותר באותו זמן' });
            if (newA > 0 && rA > 0) return resolve({ ok: false, message: 'לא ניתן לקבוע שני קידודים על אותה רשת ענן באותו זמן' });
          }
        }
      }
      return resolve({ ok: true });
    });
  });
}

function generateSlotsForDay(dayDateTime) {
  const slots = [];
  for (const blk of WORKING_BLOCKS) {
    const [bsH, bsM] = blk.start.split(':').map(Number);
    const [beH, beM] = blk.end.split(':').map(Number);
    let current = dayDateTime.plus({ hours: bsH, minutes: bsM });
    const blockEnd = dayDateTime.plus({ hours: beH, minutes: beM });
    while (current <= blockEnd.minus({ minutes: 1 })) {
      slots.push({ start: current, blockEnd });
      current = current.plus({ minutes: SLOT_STEP_MIN });
    }
  }
  return slots;
}

function fitsWithinBlock(startDT, endDT) {
  const day = startDT.startOf('day');
  for (const blk of WORKING_BLOCKS) {
    const [bsH, bsM] = blk.start.split(':').map(Number);
    const [beH, beM] = blk.end.split(':').map(Number);
    const blkStart = day.plus({ hours: bsH, minutes: bsM });
    const blkEnd = day.plus({ hours: beH, minutes: beM });
    if (startDT >= blkStart && endDT <= blkEnd) return true;
  }
  return false;
}

async function findNextAvailableSlot(serviceType, details, fromDT, sameDayOnly=false, maxDays=30) {
  const durationMin = computeDuration(serviceType, details);
  let day = fromDT.startOf('day');
  const now = DateTime.now().setZone('Asia/Jerusalem');

  for (let dayOffset = 0; dayOffset <= maxDays; dayOffset++) {
    if (dayOffset > 0) day = day.plus({ days: 1 });
    if (sameDayOnly && dayOffset > 0) break;
	
	if ([5, 6].includes(day.weekday)) continue;
	
    const slots = generateSlotsForDay(day);
    for (const s of slots) {
      const start = s.start;
      if (start < now && start.hasSame(now, 'day')) continue;
      const end = start.plus({ minutes: durationMin });
      if (!fitsWithinBlock(start, end)) continue;
      try {
        const res = await checkConflicts(start.toISO(), end.toISO(), serviceType, details);
        if (res.ok) {
          return { startISO: start.toISO(), endISO: end.toISO() };
        }
      } catch(e) {
        throw e;
      }
    }
  }
  return null;
}

// API: list all appointments
app.get('/book', (req, res) => {
  db.all('SELECT * FROM appointments ORDER BY startTime ASC', (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: 'שגיאה בקריאת הפגישות' });
    const out = rows.map(r => {
      let details = r.details;
      try { details = JSON.parse(r.details || '{}'); } catch(e){}
      return { id: r.id, serviceType: r.serviceType, details, startTime: r.startTime, endTime: r.endTime, created_at: r.created_at, phone: r.phone, done: !!r.done };
    });
    res.json(out);
  });
});

// POST /book
app.post('/book', async (req, res) => {
  try {
    let { serviceType, startTime, details, phone, done } = req.body;
    if (!serviceType) return res.status(400).json({ success:false, message: 'חסר serviceType' });

    details = parseDetails(details || {});
    const duration = computeDuration(serviceType, details);
    const isPhysical = !!startTime;
    const stLower = (serviceType || '').toString().trim().toLowerCase();
    const sameDayOnly = (stLower.includes('אישור כניסה קבוע') || stLower === 'אישור כניסה קבוע' || stLower.includes('אישור כניסה קבוע'.toLowerCase()));

    if (isPhysical) {
      const start = DateTime.fromISO(startTime, { zone: 'Asia/Jerusalem' });
      if (!start.isValid) return res.status(400).json({ success:false, message: 'פורמט startTime שגוי' });
      const end = start.plus({ minutes: duration });
      if (!fitsWithinBlock(start, end)) return res.status(400).json({ success:false, message: 'הזמן שנבחר אינו בטווח שעות העבודה או אינו נכנס במסגרת בלוק עבודה' });
      const conflict = await checkConflicts(start.toISO(), end.toISO(), serviceType, details);
      if (!conflict.ok) return res.status(409).json({ success:false, message: conflict.message });
      const stmt = db.prepare('INSERT INTO appointments (serviceType, details, startTime, endTime, created_at, phone, done) VALUES (?,?,?,?,?,?,?)');
      stmt.run(serviceType, JSON.stringify(details || {}), start.toISO(), end.toISO(), DateTime.now().setZone('Asia/Jerusalem').toISO(), phone || null, done ? 1 : 0, function(err) {
        if (err) return res.status(500).json({ success:false, message: 'שגיאה בשמירת הפגישה' });
        res.json({ success:true, message: 'הפגישה נקבעה בהצלחה', id: this.lastID, startTime: start.toISO(), endTime: end.toISO() });
      });
      return;
    } else {
      const fromDT = DateTime.now().setZone('Asia/Jerusalem');
      const slot = await findNextAvailableSlot(serviceType, details, fromDT, sameDayOnly, 30);
      if (!slot) return res.status(409).json({ success:false, message: 'אין זמינות בשבועות הקרובים' });
      const stmt = db.prepare('INSERT INTO appointments (serviceType, details, startTime, endTime, created_at, phone, done) VALUES (?,?,?,?,?,?,?)');
      stmt.run(serviceType, JSON.stringify(details || {}), slot.startISO, slot.endISO, DateTime.now().setZone('Asia/Jerusalem').toISO(), phone || null, done ? 1 : 0, function(err) {
        if (err) return res.status(500).json({ success:false, message: 'שגיאה בשמירת הפגישה' });
        res.json({ success:true, message: 'הפגישה הוקצתה בהצלחה', id: this.lastID, startTime: slot.startISO, endTime: slot.endISO });
      });
      return;
    }
  } catch (e) {
    console.error('POST /book error:', e);
    res.status(500).json({ success:false, message: 'שגיאת שרת פנימית' });
  }
});

app.delete('/book/:id', (req, res) => {
  const id = req.params.id;
  db.run('DELETE FROM appointments WHERE id = ?', [id], function(err) {
    if (err) return res.status(500).json({ success:false, message: 'שגיאה במחיקת הפגישה' });
    res.json({ success:true, message: 'הפגישה בוטלה בהצלחה' });
  });
});

app.get('/availability', (req, res) => {
  try {
    const dateStr = req.query.date;
    const serviceType = req.query.serviceType || '';
    const detailsRaw = req.query.details || '{}';
    let details = {};
    try { details = JSON.parse(detailsRaw); } catch(e){}
    if (!dateStr) return res.status(400).json({ success:false, message: 'missing date' });
    const duration = computeDuration(serviceType, details);
    const dayStart = DateTime.fromISO(dateStr, { zone: 'Asia/Jerusalem' }).startOf('day');
	if ([5, 6].includes(dayStart.weekday)) {
		return res.json({ success: true, available: [] });
	}
    if (!dayStart.isValid) return res.status(400).json({ success:false, message: 'פורמט תאריך שגוי' });
    const slots = generateSlotsForDay(dayStart);
    const now = DateTime.now().setZone('Asia/Jerusalem');
    (async () => {
      const available = [];
      for (const s of slots) {
        const start = s.start;
        if (start < now && start.hasSame(now,'day')) continue;
        const endISO = start.plus({ minutes: duration }).toISO();
        if (!fitsWithinBlock(start, start.plus({ minutes: duration }))) continue;
        const ok = await checkConflicts(start.toISO(), endISO, serviceType, details);
        if (ok.ok) available.push(start.toISO());
      }
      res.json({ success:true, available });
    })();
  } catch (e) {
    console.error(e);
    res.status(500).json({ success:false, message: 'שגיאת שרת' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
