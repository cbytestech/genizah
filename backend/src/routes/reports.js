const express = require('express');
const { getDb } = require('../models/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Wrap sync route handlers so thrown errors become 500 responses, not process crashes
function safeRoute(fn) {
  return (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (err) {
      console.error(`[Reports] ${req.method} ${req.path} error:`, err.message);
      console.error(err.stack);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}

// For CSV download: browser navigations can't send JWT headers,
// so inject token from query param into Authorization header before auth runs
router.use((req, res, next) => {
  if (req.query.token && !req.headers.authorization) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

router.use(authenticate);

// Document types classified as income (positive balance)
const INCOME_TYPES = ['Check', 'Refund', 'Paystub'];

// ── Helper: build WHERE clause + params from query string filters ──
function buildFilters(query) {
  const conditions = ["d.status != 'archived'"];
  const params = [];

  if (query.start) {
    conditions.push('d.document_date >= ?');
    params.push(query.start);
  }
  if (query.end) {
    conditions.push('d.document_date <= ?');
    params.push(query.end);
  }
  if (query.tags) {
    const tagList = query.tags.split(',').map(t => t.trim()).filter(Boolean);
    if (tagList.length > 0) {
      const placeholders = tagList.map(() => '?').join(',');
      conditions.push(`d.id IN (
        SELECT dt.document_id FROM document_tags dt
        JOIN tags tg ON tg.id = dt.tag_id
        WHERE tg.name IN (${placeholders})
      )`);
      params.push(...tagList);
    }
  }
  if (query.owners) {
    const ownerList = query.owners.split(',').map(o => o.trim()).filter(Boolean);
    if (ownerList.length > 0) {
      const placeholders = ownerList.map(() => '?').join(',');
      conditions.push(`d.id IN (
        SELECT do2.document_id FROM document_owners do2
        WHERE do2.owner_id IN (${placeholders})
      )`);
      params.push(...ownerList);
    }
  }

  return { where: conditions.join(' AND '), params };
}

// ── Helper: build income type placeholders for SQL ──
function incomeTypePlaceholders() {
  return INCOME_TYPES.map(() => '?').join(',');
}

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/dashboard
// At-a-glance stats: last purchase, top vendor, biggest expense,
// daily burn rate, busiest day, biggest spender, fun facts,
// month-over-month delta
// ══════════════════════════════════════════════════════════════════
router.get('/dashboard', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  // ── Last Purchase ──
  const lastPurchase = db.prepare(`
    SELECT d.id, d.title, d.vendor, d.amount, d.document_date, d.created_at,
      tp.name as type_name, tp.icon as type_icon
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.amount IS NOT NULL
      AND tp.name NOT IN (${itp})
    ORDER BY d.created_at DESC
    LIMIT 1
  `).get(...INCOME_TYPES, ...params);

  // ── Top Vendor (most purchases from one place) ──
  const topVendor = db.prepare(`
    SELECT d.vendor, COUNT(*) as visit_count,
      COALESCE(SUM(d.amount), 0) as total_spent
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.vendor IS NOT NULL AND d.vendor != ''
      AND tp.name NOT IN (${itp})
    GROUP BY d.vendor
    ORDER BY visit_count DESC, total_spent DESC
    LIMIT 1
  `).get(...INCOME_TYPES, ...params);

  // ── Top Vendor monthly spark data (last 6 months) ──
  let topVendorSpark = [];
  if (topVendor) {
    topVendorSpark = db.prepare(`
      SELECT strftime('%Y-%m', d.document_date) as month,
        COALESCE(SUM(d.amount), 0) as total
      FROM documents d
      LEFT JOIN document_types tp ON d.type_id = tp.id
      WHERE d.vendor = ? AND d.document_date IS NOT NULL
        AND d.status != 'archived' AND tp.name NOT IN (${itp})
      GROUP BY month ORDER BY month DESC LIMIT 6
    `).all(topVendor.vendor, ...INCOME_TYPES).reverse();
  }

  // ── Biggest Single Expense ──
  const biggestExpense = db.prepare(`
    SELECT d.id, d.title, d.vendor, d.amount, d.document_date,
      tp.name as type_name
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.amount IS NOT NULL
      AND tp.name NOT IN (${itp})
    ORDER BY d.amount DESC
    LIMIT 1
  `).get(...INCOME_TYPES, ...params);

  // ── Biggest Income ──
  const biggestIncome = db.prepare(`
    SELECT d.id, d.title, d.vendor, d.amount, d.document_date,
      tp.name as type_name
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.amount IS NOT NULL
      AND tp.name IN (${itp})
    ORDER BY d.amount DESC
    LIMIT 1
  `).get(...INCOME_TYPES, ...params);

  // ── Daily Burn Rate ──
  const dateRange = db.prepare(`
    SELECT MIN(d.document_date) as first_date, MAX(d.document_date) as last_date,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) THEN d.amount ELSE 0 END), 0) as total_expense
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.document_date IS NOT NULL AND d.amount IS NOT NULL
  `).get(...INCOME_TYPES, ...params);

  let dailyBurnRate = 0;
  let burnDays = 0;
  if (dateRange && dateRange.first_date && dateRange.last_date) {
    const msPerDay = 86400000;
    burnDays = Math.max(1, Math.round(
      (new Date(dateRange.last_date) - new Date(dateRange.first_date)) / msPerDay
    ) + 1);
    dailyBurnRate = Math.round((dateRange.total_expense / burnDays) * 100) / 100;
  }

  // ── Busiest Day of Week ──
  const busiestDay = db.prepare(`
    SELECT CAST(strftime('%w', d.document_date) AS INTEGER) as day_num,
      COUNT(*) as doc_count,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) THEN d.amount ELSE 0 END), 0) as total_expense
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.document_date IS NOT NULL
    GROUP BY day_num
    ORDER BY total_expense DESC
    LIMIT 1
  `).get(...INCOME_TYPES, ...params);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // ── Biggest Spender (owner) ──
  const biggestSpender = db.prepare(`
    SELECT o.name as owner_name, o.icon as owner_icon, o.color as owner_color,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) THEN d.amount ELSE 0 END), 0) as total_expense,
      COUNT(DISTINCT d.id) as doc_count
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    JOIN document_owners do2 ON do2.document_id = d.id
    JOIN owners o ON o.id = do2.owner_id
    WHERE ${where}
    GROUP BY o.id
    ORDER BY total_expense DESC
    LIMIT 1
  `).get(...INCOME_TYPES, ...params);

  // ── vs Last Period (month-over-month) ──
  // Figure out the current period's date range
  const start = req.query.start;
  const end = req.query.end;
  let priorDelta = null;

  if (start && end) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const periodMs = endDate - startDate;
    const priorStart = new Date(startDate - periodMs).toISOString().slice(0, 10);
    const priorEnd = new Date(startDate - 86400000).toISOString().slice(0, 10);

    const currentTotal = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) THEN d.amount ELSE 0 END), 0) as expense
      FROM documents d LEFT JOIN document_types tp ON d.type_id = tp.id
      WHERE d.status != 'archived' AND d.document_date >= ? AND d.document_date <= ?
    `).get(...INCOME_TYPES, start, end);

    const priorTotal = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) THEN d.amount ELSE 0 END), 0) as expense
      FROM documents d LEFT JOIN document_types tp ON d.type_id = tp.id
      WHERE d.status != 'archived' AND d.document_date >= ? AND d.document_date <= ?
    `).get(...INCOME_TYPES, priorStart, priorEnd);

    const curr = currentTotal.expense;
    const prev = priorTotal.expense;
    const pctChange = prev > 0 ? Math.round(((curr - prev) / prev) * 1000) / 10 : null;

    priorDelta = {
      current_expense: Math.round(curr * 100) / 100,
      prior_expense: Math.round(prev * 100) / 100,
      change_pct: pctChange,
      direction: curr > prev ? 'up' : curr < prev ? 'down' : 'flat'
    };
  }

  // ── Fun Facts ──
  const funFacts = [];

  // Most visited vendor this month
  if (topVendor && topVendor.visit_count > 1) {
    funFacts.push({
      icon: '🏪',
      text: `You've hit ${topVendor.vendor} ${topVendor.visit_count} times`
    });
  }

  // Longest gap between purchases
  const allDates = db.prepare(`
    SELECT DISTINCT d.document_date
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.document_date IS NOT NULL AND tp.name NOT IN (${itp})
    ORDER BY d.document_date ASC
  `).all(...INCOME_TYPES, ...params);

  if (allDates.length > 1) {
    let maxGap = 0;
    for (let i = 1; i < allDates.length; i++) {
      const gap = (new Date(allDates[i].document_date) - new Date(allDates[i - 1].document_date)) / 86400000;
      if (gap > maxGap) maxGap = gap;
    }
    if (maxGap >= 2) {
      funFacts.push({
        icon: '📆',
        text: `Longest gap between purchases: ${Math.round(maxGap)} days`
      });
    }
  }

  // Weekly spend at top tag
  const topTag = db.prepare(`
    SELECT tg.name, COUNT(DISTINCT d.id) as cnt,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) THEN d.amount ELSE 0 END), 0) as total
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    JOIN document_tags dt ON dt.document_id = d.id
    JOIN tags tg ON tg.id = dt.tag_id
    WHERE ${where}
    GROUP BY tg.name
    ORDER BY total DESC
    LIMIT 1
  `).get(...INCOME_TYPES, ...params);

  if (topTag && burnDays > 0) {
    const weeklySpend = Math.round((topTag.total / burnDays) * 7 * 100) / 100;
    if (weeklySpend > 0) {
      funFacts.push({
        icon: '💳',
        text: `$${weeklySpend}/week on "${topTag.name}"`
      });
    }
  }

  // Total unique vendors
  const uniqueVendors = db.prepare(`
    SELECT COUNT(DISTINCT d.vendor) as cnt
    FROM documents d
    WHERE ${where} AND d.vendor IS NOT NULL AND d.vendor != ''
  `).get(...params);

  if (uniqueVendors && uniqueVendors.cnt > 0) {
    funFacts.push({
      icon: '🏬',
      text: `${uniqueVendors.cnt} different vendors`
    });
  }

  // Days since last purchase
  if (lastPurchase && lastPurchase.created_at) {
    const daysSince = Math.round((Date.now() - new Date(lastPurchase.created_at)) / 86400000);
    if (daysSince === 0) {
      funFacts.push({ icon: '🛒', text: 'Last purchase was today' });
    } else if (daysSince === 1) {
      funFacts.push({ icon: '🛒', text: 'Last purchase was yesterday' });
    } else if (daysSince > 1) {
      funFacts.push({ icon: '🛒', text: `${daysSince} days since last purchase` });
    }
  }

  res.json({
    last_purchase: lastPurchase ? {
      id: lastPurchase.id,
      title: lastPurchase.title,
      vendor: lastPurchase.vendor,
      amount: lastPurchase.amount != null ? Math.round(lastPurchase.amount * 100) / 100 : null,
      date: lastPurchase.document_date,
      created_at: lastPurchase.created_at,
      type: lastPurchase.type_name,
      type_icon: lastPurchase.type_icon
    } : null,

    top_vendor: topVendor ? {
      vendor: topVendor.vendor,
      visit_count: topVendor.visit_count,
      total_spent: Math.round(topVendor.total_spent * 100) / 100,
      spark: topVendorSpark.map(s => ({ month: s.month, total: Math.round(s.total * 100) / 100 }))
    } : null,

    biggest_expense: biggestExpense ? {
      id: biggestExpense.id,
      title: biggestExpense.title,
      vendor: biggestExpense.vendor,
      amount: Math.round(biggestExpense.amount * 100) / 100,
      date: biggestExpense.document_date,
      type: biggestExpense.type_name
    } : null,

    biggest_income: biggestIncome ? {
      id: biggestIncome.id,
      title: biggestIncome.title,
      vendor: biggestIncome.vendor,
      amount: Math.round(biggestIncome.amount * 100) / 100,
      date: biggestIncome.document_date,
      type: biggestIncome.type_name
    } : null,

    daily_burn_rate: dailyBurnRate,
    burn_days: burnDays,

    busiest_day: busiestDay ? {
      day: dayNames[busiestDay.day_num] || 'Unknown',
      doc_count: busiestDay.doc_count,
      total_expense: Math.round(busiestDay.total_expense * 100) / 100
    } : null,

    biggest_spender: biggestSpender ? {
      owner: biggestSpender.owner_name,
      icon: biggestSpender.owner_icon,
      color: biggestSpender.owner_color,
      total_expense: Math.round(biggestSpender.total_expense * 100) / 100,
      doc_count: biggestSpender.doc_count
    } : null,

    vs_last_period: priorDelta,
    fun_facts: funFacts
  });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/summary
// Aggregated totals: income, expenses, net, doc count
// ══════════════════════════════════════════════════════════════════
router.get('/summary', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  const row = db.prepare(`
    SELECT
      COUNT(*) as doc_count,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as total_income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as total_expenses
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where}
  `).get(...INCOME_TYPES, ...INCOME_TYPES, ...params);

  res.json({
    doc_count: row.doc_count,
    total_income: Math.round(row.total_income * 100) / 100,
    total_expenses: Math.round(row.total_expenses * 100) / 100,
    net: Math.round((row.total_income - row.total_expenses) * 100) / 100
  });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/by-tag
// Spending/income grouped by tag with totals and percentages
// ══════════════════════════════════════════════════════════════════
router.get('/by-tag', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  const rows = db.prepare(`
    SELECT
      tg.name as tag_name,
      COUNT(DISTINCT d.id) as doc_count,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as expense
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    JOIN document_tags dt ON dt.document_id = d.id
    JOIN tags tg ON tg.id = dt.tag_id
    WHERE ${where}
    GROUP BY tg.name
    ORDER BY expense DESC, income DESC
  `).all(...INCOME_TYPES, ...INCOME_TYPES, ...params);

  // Calculate percentages
  const totalSpend = rows.reduce((sum, r) => sum + r.expense, 0);
  const totalIncome = rows.reduce((sum, r) => sum + r.income, 0);

  const result = rows.map(r => ({
    tag: r.tag_name,
    doc_count: r.doc_count,
    income: Math.round(r.income * 100) / 100,
    expense: Math.round(r.expense * 100) / 100,
    net: Math.round((r.income - r.expense) * 100) / 100,
    expense_pct: totalSpend > 0 ? Math.round((r.expense / totalSpend) * 1000) / 10 : 0,
    income_pct: totalIncome > 0 ? Math.round((r.income / totalIncome) * 1000) / 10 : 0
  }));

  res.json({ tags: result, totals: { income: Math.round(totalIncome * 100) / 100, expense: Math.round(totalSpend * 100) / 100 } });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/by-vendor
// Top vendors ranked by total spend + doc count
// ══════════════════════════════════════════════════════════════════
router.get('/by-vendor', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();
  const vendorLimit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));

  const rows = db.prepare(`
    SELECT
      d.vendor,
      COUNT(*) as doc_count,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as expense,
      MIN(d.document_date) as first_seen,
      MAX(d.document_date) as last_seen,
      COUNT(DISTINCT strftime('%Y-%m', d.document_date)) as months_active
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.vendor IS NOT NULL AND d.vendor != ''
    GROUP BY d.vendor
    ORDER BY expense DESC
    LIMIT ?
  `).all(...INCOME_TYPES, ...INCOME_TYPES, ...params, vendorLimit);

  const totalSpend = rows.reduce((sum, r) => sum + r.expense, 0);

  const result = rows.map(r => ({
    vendor: r.vendor,
    doc_count: r.doc_count,
    income: Math.round(r.income * 100) / 100,
    expense: Math.round(r.expense * 100) / 100,
    expense_pct: totalSpend > 0 ? Math.round((r.expense / totalSpend) * 1000) / 10 : 0,
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    months_active: r.months_active,
    recurring: r.months_active >= 3
  }));

  res.json({ vendors: result, total_spend: Math.round(totalSpend * 100) / 100 });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/by-owner
// Spending split by owner
// ══════════════════════════════════════════════════════════════════
router.get('/by-owner', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  const rows = db.prepare(`
    SELECT
      o.id as owner_id,
      o.name as owner_name,
      o.color as owner_color,
      o.icon as owner_icon,
      COUNT(DISTINCT d.id) as doc_count,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as expense
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    JOIN document_owners do2 ON do2.document_id = d.id
    JOIN owners o ON o.id = do2.owner_id
    WHERE ${where}
    GROUP BY o.id
    ORDER BY o.sort_order ASC
  `).all(...INCOME_TYPES, ...INCOME_TYPES, ...params);

  const result = rows.map(r => ({
    owner_id: r.owner_id,
    owner: r.owner_name,
    color: r.owner_color,
    icon: r.owner_icon,
    doc_count: r.doc_count,
    income: Math.round(r.income * 100) / 100,
    expense: Math.round(r.expense * 100) / 100,
    net: Math.round((r.income - r.expense) * 100) / 100
  }));

  res.json({ owners: result });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/by-month
// Month-by-month breakdown with tag sub-totals (feeds stacked bar)
// ══════════════════════════════════════════════════════════════════
router.get('/by-month', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  // Get month-level totals with tag breakdown
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', d.document_date) as month,
      tg.name as tag_name,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as expense,
      COUNT(DISTINCT d.id) as doc_count
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    JOIN document_tags dt ON dt.document_id = d.id
    JOIN tags tg ON tg.id = dt.tag_id
    WHERE ${where} AND d.document_date IS NOT NULL
    GROUP BY month, tg.name
    ORDER BY month ASC, expense DESC
  `).all(...INCOME_TYPES, ...INCOME_TYPES, ...params);

  // Also get docs without tags
  const untaggedRows = db.prepare(`
    SELECT
      strftime('%Y-%m', d.document_date) as month,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as expense,
      COUNT(DISTINCT d.id) as doc_count
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.document_date IS NOT NULL
      AND d.id NOT IN (SELECT document_id FROM document_tags)
    GROUP BY month
    ORDER BY month ASC
  `).all(...INCOME_TYPES, ...INCOME_TYPES, ...params);

  // Pivot into { month: "2026-08", tags: { groceries: { income, expense }, ... }, total_income, total_expense }
  const monthMap = {};
  const allTags = new Set();

  for (const row of rows) {
    if (!monthMap[row.month]) {
      monthMap[row.month] = { month: row.month, tags: {}, total_income: 0, total_expense: 0, doc_count: 0 };
    }
    const m = monthMap[row.month];
    m.tags[row.tag_name] = {
      income: Math.round(row.income * 100) / 100,
      expense: Math.round(row.expense * 100) / 100
    };
    m.total_income += row.income;
    m.total_expense += row.expense;
    m.doc_count += row.doc_count;
    allTags.add(row.tag_name);
  }

  // Merge untagged
  for (const row of untaggedRows) {
    if (!monthMap[row.month]) {
      monthMap[row.month] = { month: row.month, tags: {}, total_income: 0, total_expense: 0, doc_count: 0 };
    }
    const m = monthMap[row.month];
    m.tags['(untagged)'] = {
      income: Math.round(row.income * 100) / 100,
      expense: Math.round(row.expense * 100) / 100
    };
    m.total_income += row.income;
    m.total_expense += row.expense;
    m.doc_count += row.doc_count;
    allTags.add('(untagged)');
  }

  // Round totals and convert to array
  const months = Object.values(monthMap).map(m => ({
    ...m,
    total_income: Math.round(m.total_income * 100) / 100,
    total_expense: Math.round(m.total_expense * 100) / 100
  }));

  res.json({ months, all_tags: Array.from(allTags).sort() });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/by-day-of-week
// Day-of-week spending pattern analysis
// ══════════════════════════════════════════════════════════════════
router.get('/by-day-of-week', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  // strftime('%w', date) returns 0=Sunday, 1=Monday, ... 6=Saturday
  const rows = db.prepare(`
    SELECT
      CAST(strftime('%w', d.document_date) AS INTEGER) as day_num,
      COUNT(*) as doc_count,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as expense
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.document_date IS NOT NULL
    GROUP BY day_num
    ORDER BY day_num ASC
  `).all(...INCOME_TYPES, ...INCOME_TYPES, ...params);

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Find top tag per day
  const topTagByDay = db.prepare(`
    SELECT
      CAST(strftime('%w', d.document_date) AS INTEGER) as day_num,
      tg.name as tag_name,
      COUNT(*) as cnt
    FROM documents d
    JOIN document_tags dt ON dt.document_id = d.id
    JOIN tags tg ON tg.id = dt.tag_id
    WHERE ${where} AND d.document_date IS NOT NULL
    GROUP BY day_num, tg.name
    ORDER BY day_num, cnt DESC
  `).all(...params);

  // Build a map of day_num -> top tag
  const topTags = {};
  for (const row of topTagByDay) {
    if (!topTags[row.day_num]) {
      topTags[row.day_num] = row.tag_name;
    }
  }

  const result = rows.map(r => ({
    day: dayNames[r.day_num] || 'Unknown',
    day_num: r.day_num,
    doc_count: r.doc_count,
    income: Math.round(r.income * 100) / 100,
    expense: Math.round(r.expense * 100) / 100,
    avg_per_transaction: r.doc_count > 0 ? Math.round((r.expense / r.doc_count) * 100) / 100 : 0,
    top_tag: topTags[r.day_num] || null
  }));

  res.json({ days: result });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/trend
// Monthly income vs expense totals over time (feeds trend line)
// ══════════════════════════════════════════════════════════════════
router.get('/trend', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', d.document_date) as month,
      COUNT(*) as doc_count,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as expense
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where} AND d.document_date IS NOT NULL
    GROUP BY month
    ORDER BY month ASC
  `).all(...INCOME_TYPES, ...INCOME_TYPES, ...params);

  const result = rows.map(r => ({
    month: r.month,
    doc_count: r.doc_count,
    income: Math.round(r.income * 100) / 100,
    expense: Math.round(r.expense * 100) / 100,
    net: Math.round((r.income - r.expense) * 100) / 100
  }));

  res.json({ trend: result });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/export/csv
// CSV download of filtered data
// Accepts token as query param since browser downloads can't send JWT headers
// ══════════════════════════════════════════════════════════════════
router.get('/export/csv', safeRoute((req, res) => {
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  const rows = db.prepare(`
    SELECT
      d.id,
      d.document_date,
      d.title,
      d.vendor,
      d.amount,
      tp.name as type_name,
      CASE WHEN tp.name IN (${itp}) THEN 'Income' ELSE 'Expense' END as direction,
      d.notes,
      d.created_at
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where}
    ORDER BY d.document_date ASC
  `).all(...INCOME_TYPES, ...params);

  // Get tags and owners for each doc
  const tagStmt = db.prepare('SELECT t.name FROM tags t JOIN document_tags dt ON t.id = dt.tag_id WHERE dt.document_id = ?');
  const ownerStmt = db.prepare('SELECT o.name FROM owners o JOIN document_owners do2 ON o.id = do2.owner_id WHERE do2.document_id = ?');

  // Build CSV
  const csvHeader = 'Date,Title,Vendor,Amount,Type,Direction,Owner(s),Tags';
  const csvRows = rows.map(r => {
    const tags = tagStmt.all(r.id).map(t => t.name).join('; ');
    const owners = ownerStmt.all(r.id).map(o => o.name).join('; ');
    return [
      r.document_date || '',
      csvEscape(r.title),
      csvEscape(r.vendor || ''),
      r.amount != null ? r.amount.toFixed(2) : '',
      csvEscape(r.type_name || ''),
      r.direction,
      csvEscape(owners),
      csvEscape(tags)
    ].join(',');
  });

  const csv = [csvHeader, ...csvRows].join('\n');

  // Build filename from date range
  const startDate = req.query.start || 'all';
  const endDate = req.query.end || 'time';
  const filename = `genizah-report-${startDate}-to-${endDate}.csv`;

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
}));

// CSV escape helper: wrap in quotes if value contains comma, quote, or newline
function csvEscape(val) {
  if (!val) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/expiring
// Documents expiring within N days + recently expired (last 30 days)
// ══════════════════════════════════════════════════════════════════
router.get('/expiring', safeRoute((req, res) => {
  const db = getDb();
  const days = Math.min(parseInt(req.query.days) || 90, 365);

  const today = new Date().toISOString().slice(0, 10);
  const futureDate = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const pastDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const expiringSoon = db.prepare(`
    SELECT d.id, d.title, d.vendor, d.amount, d.document_date,
      d.expiration_date, tp.name as type_name, tp.icon as type_icon
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE d.status != 'archived'
      AND d.expiration_date IS NOT NULL
      AND d.expiration_date >= ?
      AND d.expiration_date <= ?
    ORDER BY d.expiration_date ASC
  `).all(today, futureDate);

  const recentlyExpired = db.prepare(`
    SELECT d.id, d.title, d.vendor, d.amount, d.document_date,
      d.expiration_date, tp.name as type_name, tp.icon as type_icon
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE d.status != 'archived'
      AND d.expiration_date IS NOT NULL
      AND d.expiration_date >= ?
      AND d.expiration_date < ?
    ORDER BY d.expiration_date DESC
  `).all(pastDate, today);

  res.json({
    expiring_soon: expiringSoon,
    recently_expired: recentlyExpired,
    window_days: days
  });
}));

// ══════════════════════════════════════════════════════════════════
// GET /api/reports/export/pdf
// PDF report download with summary header + document table
// Uses pdfkit; accepts same filters as CSV + token in query param
// ══════════════════════════════════════════════════════════════════
router.get('/export/pdf', safeRoute((req, res) => {
  const PDFDocument = require('pdfkit');
  const db = getDb();
  const { where, params } = buildFilters(req.query);
  const itp = incomeTypePlaceholders();

  // ── Summary data ──
  const summary = db.prepare(`
    SELECT
      COUNT(*) as doc_count,
      COALESCE(SUM(CASE WHEN tp.name IN (${itp}) THEN d.amount ELSE 0 END), 0) as total_income,
      COALESCE(SUM(CASE WHEN tp.name NOT IN (${itp}) AND d.amount IS NOT NULL THEN d.amount ELSE 0 END), 0) as total_expenses
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where}
  `).get(...INCOME_TYPES, ...INCOME_TYPES, ...params);
  summary.net = Math.round((summary.total_income - summary.total_expenses) * 100) / 100;

  // ── Document rows ──
  const rows = db.prepare(`
    SELECT
      d.id, d.document_date, d.title, d.vendor, d.amount,
      tp.name as type_name,
      CASE WHEN tp.name IN (${itp}) THEN 'Income' ELSE 'Expense' END as direction
    FROM documents d
    LEFT JOIN document_types tp ON d.type_id = tp.id
    WHERE ${where}
    ORDER BY d.document_date ASC
  `).all(...INCOME_TYPES, ...params);

  const tagStmt = db.prepare('SELECT t.name FROM tags t JOIN document_tags dt ON t.id = dt.tag_id WHERE dt.document_id = ?');
  const ownerStmt = db.prepare('SELECT o.name FROM owners o JOIN document_owners do2 ON o.id = do2.owner_id WHERE do2.document_id = ?');

  // ── Build PDF ──
  const doc = new PDFDocument({ size: 'letter', margin: 50, bufferPages: true });

  // Date range for header
  const startDate = req.query.start || 'All';
  const endDate = req.query.end || 'Time';
  const filename = `genizah-report-${startDate}-to-${endDate}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  // Colors
  const ORANGE = '#ff9800';
  const GREEN = '#3ad98e';
  const RED = '#ef5350';
  const DARK = '#1a1d2e';
  const GRAY = '#6b7280';
  const LIGHT_BG = '#f8f9fa';
  const WHITE = '#ffffff';
  const BORDER = '#e5e7eb';

  // ── Header ──
  doc.rect(0, 0, doc.page.width, 80).fill(DARK);
  doc.fontSize(22).fill(ORANGE).text('GENIZAH', 50, 22, { continued: true });
  doc.fontSize(11).fill('#8a8d9b').text('  Digital Filing Cabinet', { baseline: 'alphabetic' });
  doc.fontSize(9).fill('#8a8d9b').text(
    `Report: ${startDate === 'All' ? 'All Time' : startDate + ' to ' + endDate}`,
    50, 50
  );
  doc.fontSize(8).fill('#8a8d9b').text(
    `Generated ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
    50, 62
  );

  // ── Summary Cards ──
  const cardY = 100;
  const cardW = 120;
  const cardH = 55;
  const cardGap = 12;
  const cards = [
    { label: 'INCOME', value: `$${summary.total_income.toFixed(2)}`, color: GREEN },
    { label: 'EXPENSES', value: `$${summary.total_expenses.toFixed(2)}`, color: RED },
    { label: 'NET', value: `${summary.net >= 0 ? '+' : ''}$${summary.net.toFixed(2)}`, color: summary.net >= 0 ? GREEN : RED },
    { label: 'DOCUMENTS', value: String(summary.doc_count), color: ORANGE },
  ];

  cards.forEach((card, i) => {
    const x = 50 + i * (cardW + cardGap);
    doc.roundedRect(x, cardY, cardW, cardH, 4).fill(LIGHT_BG);
    doc.fontSize(15).fill(card.color).text(card.value, x, cardY + 10, { width: cardW, align: 'center' });
    doc.fontSize(7).fill(GRAY).text(card.label, x, cardY + 32, { width: cardW, align: 'center' });
  });

  // ── Table ──
  const tableTop = cardY + cardH + 25;
  const colWidths = [68, 160, 55, 55, 55, 80, 55];
  const colHeaders = ['Date', 'Vendor', 'Amount', 'Type', 'Dir.', 'Owner', 'Tags'];
  const tableLeft = 50;
  const rowHeight = 18;

  // Table header
  doc.rect(tableLeft, tableTop, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(DARK);
  let hx = tableLeft;
  colHeaders.forEach((h, i) => {
    doc.fontSize(7.5).fill(WHITE).text(h, hx + 4, tableTop + 5, { width: colWidths[i] - 8 });
    hx += colWidths[i];
  });

  // Table rows
  let y = tableTop + rowHeight;
  const maxY = doc.page.height - 60; // leave room for footer

  rows.forEach((row, idx) => {
    if (y + rowHeight > maxY) {
      doc.addPage();
      y = 50;
      // Repeat header on new page
      doc.rect(tableLeft, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(DARK);
      let hx2 = tableLeft;
      colHeaders.forEach((h, i) => {
        doc.fontSize(7.5).fill(WHITE).text(h, hx2 + 4, y + 5, { width: colWidths[i] - 8 });
        hx2 += colWidths[i];
      });
      y += rowHeight;
    }

    // Alternating row background
    if (idx % 2 === 0) {
      doc.rect(tableLeft, y, colWidths.reduce((a, b) => a + b, 0), rowHeight).fill(LIGHT_BG);
    }

    const tags = tagStmt.all(row.id).map(t => t.name).join(', ');
    const owners = ownerStmt.all(row.id).map(o => o.name).join(', ');
    const amountColor = row.direction === 'Income' ? GREEN : DARK;

    const cells = [
      row.document_date || '',
      row.vendor || row.title || '',
      row.amount != null ? '$' + Number(row.amount).toFixed(2) : '',
      row.type_name || '',
      row.direction || '',
      owners,
      tags.length > 20 ? tags.substring(0, 18) + '..' : tags,
    ];

    let cx = tableLeft;
    cells.forEach((cell, i) => {
      const color = (i === 2) ? amountColor : DARK;
      doc.fontSize(7).fill(color).text(cell, cx + 4, y + 5, {
        width: colWidths[i] - 8,
        ellipsis: true,
        height: rowHeight - 4,
        lineBreak: false,
      });
      cx += colWidths[i];
    });

    y += rowHeight;
  });

  // ── Footer ──
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).fill(GRAY).text(
      `Genizah · Page ${i + 1} of ${pageCount}`,
      50, doc.page.height - 35,
      { width: doc.page.width - 100, align: 'center' }
    );
  }

  doc.end();
}));

module.exports = router;
