// Gmail Receipt Scanner Service (v0.5d.3)
// Scans linked Gmail accounts for receipts, invoices, warranties, manuals
// Creates Genizah documents automatically with OCR and parsed metadata
//
// v0.5d.3 changes:
//   - Venmo: parse "for" note from body, extract actual vendor, dedup against vendor receipts
//   - DoorDash: extract restaurant name, format title as "DD, [restaurant], $total"
//   - Audible + Fetch: default-blocked domains (checked alongside user rules)
//   - Cinch Auto: auto-classify as Subscription, set vendor to "Cinch Auto"
//   - Bug fix: moved parseReceiptFields() call before sold/bought match (was ReferenceError)
//
// Schema reference (all PKs are TEXT UUIDs):
//   documents:            id, title, type_id, uploaded_by, file_path (NOT NULL), vendor, amount, document_date, notes, ocr_text, ...
//   document_attachments: id, document_id, file_path, original_filename, mime_type, file_size, sort_order
//   document_owners:      document_id, owner_id (refs owners.id, NOT users.id)
//   document_tags:        document_id, tag_id
//   owners:               id, name (Norm, Emily, Homestead, CBT, Pastoral)
//   tags:                 id, name
//   document_types:       id, name
//   users:                id, display_name, google_* columns
//   activity_log:         id (TEXT), user_id, action, detail, document_id, notified, created_at
//   vendor_aliases:       ocr_text, corrected_name

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('../models/database');
const { extractText } = require('./ocr');
const { generateThumbnail } = require('./thumbnails');

// ── Config ──────────────────────────────────────────────────────────────

const UPLOAD_PATH = process.env.UPLOAD_PATH || '/app/data/files';
const THUMBNAIL_PATH = process.env.THUMBNAIL_PATH || '/app/data/thumbnails';

// Gmail search query: targeted keywords to find receipts without pulling garbage
// We intentionally avoid category:purchases (too broad, catches tracking/status emails)
const SEARCH_KEYWORDS = [
  'receipt', 'invoice', 'order confirmation', 'order shipped',
  'order delivered',
  'payment received', 'payment confirmation', 'purchase confirmation',
  'shipping confirmation', 'delivery confirmation', 'warranty',
  'billing statement', 'transaction receipt', 'subscription confirmation',
  'renewal confirmation', 'refund', 'return confirmation',
  'your order', 'your purchase', 'thanks for your order',
  'delivery order', 'thanks for your',
  'you spent', 'transaction complete', 'payment successful',
  'Delivered:', 'Confirmation',
  'you paid',          // Venmo payment notifications
  'paid you',          // Venmo incoming payments
  'cash back',         // Venmo cashback
].map(k => `"${k}"`).join(' OR ');

// Subject-only matching keeps it targeted; -in:sent excludes user's own forwards
const DEFAULT_QUERY = `subject:(${SEARCH_KEYWORDS}) -is:spam -is:trash -is:draft -in:sent`;

// Map subject keywords to Genizah document types
const TYPE_MAP = [
  { pattern: /invoice/i, type: 'Invoice' },
  { pattern: /warranty/i, type: 'Warranty' },
  { pattern: /manual/i, type: 'Manual' },
  { pattern: /subscri/i, type: 'Subscription' },
  { pattern: /ship|deliver/i, type: 'Shipping' },
  { pattern: /refund|return/i, type: 'Refund' },
  { pattern: /paystub|pay stub|pay statement|earnings statement/i, type: 'Paystub' },
  { pattern: /direct deposit|paycheck|payroll/i, type: 'Check' },
  // Default fallback is "Receipt"
];

// Attachment types we process
const SUPPORTED_MIME = new Set([
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/tiff',
]);

// ── Default Blocked Domains ─────────────────────────────────────────────
// Checked alongside per-user gmail_sender_rules. These senders generate
// noise (rewards programs, audiobook confirmations) with no financial value.

const DEFAULT_BLOCKED_DOMAINS = [
  'audible.com',       // Audiobook purchase confirmations, no dollar amount
  'fetchrewards.com',  // Rewards/points app, not real receipts
];

// ── Sender-specific Overrides ───────────────────────────────────────────
// Map sender domains/addresses to auto-classification behavior.
// Checked in processMessage after body extraction.

const SENDER_OVERRIDES = {
  // Cinch Auto: home warranty / auto protection recurring payments
  'cinch.com': { vendor: 'Cinch Auto', type: 'Subscription' },
};

// Concurrency guard: prevents overlapping scans per user
const activeScans = new Map();

// ── Database Migrations ─────────────────────────────────────────────────

function initGmailScanTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS gmail_processed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT,
      document_id TEXT,
      subject TEXT,
      sender TEXT,
      email_date TEXT,
      status TEXT DEFAULT 'processed',
      skip_reason TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (document_id) REFERENCES documents(id),
      UNIQUE(user_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS gmail_scan_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      scan_type TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      messages_found INTEGER DEFAULT 0,
      documents_created INTEGER DEFAULT 0,
      duplicates_skipped INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running',
      error_message TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS gmail_sender_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      sender_name TEXT,
      action TEXT NOT NULL DEFAULT 'block',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, sender_email)
    );

    CREATE INDEX IF NOT EXISTS idx_gmail_processed_user_msg
      ON gmail_processed(user_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_gmail_scan_runs_user
      ON gmail_scan_runs(user_id, started_at);
  `);

  // Ensure document types exist for auto-classification (TEXT UUIDs)
  const ensureType = getDb().prepare(
    'INSERT OR IGNORE INTO document_types (id, name) VALUES (?, ?)'
  );
  ['Receipt', 'Invoice', 'Warranty', 'Manual', 'Subscription', 'Shipping', 'Refund', 'Check', 'Paystub']
    .forEach(t => ensureType.run(crypto.randomUUID(), t));

  // Ensure "gmail-scan" tag exists
  const existingTag = getDb().prepare('SELECT id FROM tags WHERE name = ?').get('gmail-scan');
  if (!existingTag) {
    getDb().prepare('INSERT INTO tags (id, name) VALUES (?, ?)').run(crypto.randomUUID(), 'gmail-scan');
  }

  console.log('[Gmail Scanner] Tables initialized');
}

// ── Gmail API Client ────────────────────────────────────────────────────

function createGmailClient(user) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: user.google_access_token,
    refresh_token: user.google_refresh_token,
    expiry_date: user.google_token_expires,
  });

  // Save refreshed tokens back to DB
  oauth2Client.on('tokens', (tokens) => {
    const setClauses = [];
    const values = [];
    if (tokens.access_token) {
      setClauses.push('google_access_token = ?');
      values.push(tokens.access_token);
    }
    if (tokens.refresh_token) {
      setClauses.push('google_refresh_token = ?');
      values.push(tokens.refresh_token);
    }
    if (tokens.expiry_date) {
      setClauses.push('google_token_expires = ?');
      values.push(String(tokens.expiry_date));
    }
    if (setClauses.length > 0) {
      values.push(user.id);
      getDb().prepare(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
    }
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// ── Email Parsing Helpers ───────────────────────────────────────────────

function getHeader(headers, name) {
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

function extractSenderEmail(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1].toLowerCase() : fromHeader.toLowerCase().trim();
}

function extractSenderName(fromHeader) {
  if (!fromHeader) return '';
  const match = fromHeader.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : '';
}

// Get plain text body from message parts (recursive)
function extractBodyText(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Multipart: look for text/plain first, then strip HTML
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    for (const part of payload.parts) {
      const text = extractBodyText(part);
      if (text) return text;
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        const html = Buffer.from(part.body.data, 'base64url').toString('utf-8');
        return stripHtml(html);
      }
    }
  }

  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    const html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
    return stripHtml(html);
  }

  return '';
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<\/th>/gi, '  ')
    .replace(/<[^>]*>/g, '')
    // Named HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&copy;/gi, '©')
    .replace(/&reg;/gi, '®')
    .replace(/&trade;/gi, '™')
    // Zero-width and invisible characters (the garbage)
    .replace(/&zwnj;/gi, '')
    .replace(/&zwj;/gi, '')
    .replace(/&lrm;/gi, '')
    .replace(/&rlm;/gi, '')
    .replace(/&#8202;/g, '')   // hair space
    .replace(/&#8203;/g, '')   // zero-width space
    .replace(/&#8204;/g, '')   // zero-width non-joiner
    .replace(/&#8205;/g, '')   // zero-width joiner
    .replace(/&#65279;/g, '')  // BOM
    .replace(/&#x200B;/gi, '') // zero-width space (hex)
    .replace(/&#x200C;/gi, '') // zero-width non-joiner (hex)
    .replace(/&#x200D;/gi, '') // zero-width joiner (hex)
    .replace(/&#\d+;/g, '')    // catch remaining numeric entities
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')          // collapse horizontal whitespace
    .replace(/^ +| +$/gm, '')         // trim each line
    .replace(/\n{3,}/g, '\n\n')       // max 2 consecutive newlines
    .replace(/^\s*\n/gm, '')          // remove blank lines
    .trim();
}

// ── JSON-LD Schema.org Parsing ──────────────────────────────────────────
// Many retailers (Walmart, Amazon, Target, Home Depot) embed structured
// order data as JSON-LD in their emails. This gives us clean machine-readable
// fields instead of scraping garbled HTML text.

// Extract raw HTML from email parts (separate from text extraction)
function extractRawHtml(payload) {
  if (!payload) return null;
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
      const result = extractRawHtml(part);
      if (result) return result;
    }
  }
  return null;
}

// Find and parse all JSON-LD blocks from HTML
function extractJsonLd(html) {
  if (!html) return null;
  const regex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const results = [];
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      // Could be a single object or an array
      if (Array.isArray(data)) results.push(...data);
      else results.push(data);
    } catch (e) {
      // Malformed JSON-LD, skip
    }
  }
  return results.length > 0 ? results : null;
}

// Extract order/invoice data from JSON-LD schema.org objects
function parseSchemaData(jsonLdArray) {
  // Flatten @graph if present
  const flat = [];
  for (const item of jsonLdArray) {
    if (item['@graph']) flat.push(...item['@graph']);
    else flat.push(item);
  }

  // Look for Order, Invoice, or EmailMessage with order action
  for (const obj of flat) {
    const type = obj['@type'];
    if (type === 'Order' || type === 'Invoice') {
      return parseOrderSchema(obj);
    }
    // Some emails wrap order in an EmailMessage
    if (type === 'EmailMessage' && obj.about && obj.about['@type'] === 'Order') {
      return parseOrderSchema(obj.about);
    }
  }

  // Check for potentialAction with ViewAction on an Order
  for (const obj of flat) {
    if (obj.potentialAction) {
      const actions = Array.isArray(obj.potentialAction) ? obj.potentialAction : [obj.potentialAction];
      for (const action of actions) {
        if (action.target && action['@type'] === 'ViewAction' && obj.description) {
          // Some retailers only embed minimal schema with a view link
          return { vendor: obj.sender?.name || null, description: obj.description, minimal: true };
        }
      }
    }
  }

  return null;
}

// Parse a schema.org Order object into clean fields
function parseOrderSchema(order) {
  const result = {
    orderNumber: order.orderNumber || null,
    vendor: null,
    amount: null,
    date: null,
    status: null,
    items: [],
    currency: order.priceCurrency || 'USD',
    minimal: false,
  };

  // Merchant/seller name
  if (order.merchant) result.vendor = order.merchant.name || (typeof order.merchant === 'string' ? order.merchant : null);
  if (!result.vendor && order.seller) result.vendor = order.seller.name || (typeof order.seller === 'string' ? order.seller : null);
  if (!result.vendor && order.broker) result.vendor = order.broker.name || null;

  // Total price
  if (order.price != null) result.amount = parseFloat(order.price);
  if (!result.amount && order.totalPaymentDue) {
    result.amount = parseFloat(order.totalPaymentDue.value || order.totalPaymentDue.price || order.totalPaymentDue);
  }
  if (!result.amount && order.partOfInvoice) {
    result.amount = parseFloat(order.partOfInvoice.totalPaymentDue?.value || order.partOfInvoice.totalPaymentDue?.price || 0);
  }

  // Order date
  if (order.orderDate) result.date = order.orderDate.split('T')[0];

  // Status (strip schema.org URL prefix)
  if (order.orderStatus) {
    result.status = String(order.orderStatus)
      .replace(/https?:\/\/schema\.org\//i, '')
      .replace('OrderStatus/', '')
      .replace('Order', '');
  }

  // Items from acceptedOffer
  if (order.acceptedOffer) {
    const offers = Array.isArray(order.acceptedOffer) ? order.acceptedOffer : [order.acceptedOffer];
    for (const offer of offers) {
      const item = {
        name: offer.itemOffered?.name || offer.itemOffered || null,
        price: offer.price != null ? parseFloat(offer.price) : null,
        quantity: offer.eligibleQuantity?.value || offer.quantity || 1,
      };
      if (item.name) result.items.push(item);
    }
  }

  // Items from orderedItem
  if (order.orderedItem) {
    const ordered = Array.isArray(order.orderedItem) ? order.orderedItem : [order.orderedItem];
    for (const oi of ordered) {
      const item = {
        name: oi.name || oi.orderedItem?.name || null,
        price: oi.orderItemPrice?.price != null ? parseFloat(oi.orderItemPrice.price) : (oi.price != null ? parseFloat(oi.price) : null),
        quantity: oi.orderQuantity || 1,
      };
      if (item.name) result.items.push(item);
    }
  }

  return result;
}

// Format clean notes from schema.org order data
function formatSchemaOrder(data, from, emailDate, subject) {
  const lines = [];

  // Header
  const title = data.vendor || 'Order';
  lines.push(`📧 ${title}${data.orderNumber ? ' #' + data.orderNumber : ''}`);
  lines.push(`From: ${from}`);
  lines.push(`Date: ${data.date || new Date(emailDate).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}`);
  if (data.status) lines.push(`Status: ${data.status}`);
  if (subject) lines.push(`Subject: ${subject}`);
  lines.push('---');

  // Items list
  if (data.items.length > 0) {
    lines.push('');
    lines.push('Items:');
    for (const item of data.items) {
      const parts = [];
      if (item.quantity > 1) parts.push(`${item.quantity}x`);
      parts.push(item.name || 'Unknown item');
      if (item.price != null) parts.push(`$${item.price.toFixed(2)}`);
      lines.push(`  ${parts.join('  ')}`);
    }
  }

  // Total
  if (data.amount != null) {
    lines.push('');
    lines.push(`Total: $${data.amount.toFixed(2)}`);
  }

  return lines.join('\n');
}

// Find attachments in message parts (recursive)
function findAttachments(payload, attachments = []) {
  if (!payload) return attachments;

  if (payload.filename && payload.body && payload.body.attachmentId) {
    const mime = (payload.mimeType || '').toLowerCase();
    if (SUPPORTED_MIME.has(mime)) {
      attachments.push({
        filename: payload.filename,
        mimeType: mime,
        attachmentId: payload.body.attachmentId,
        size: payload.body.size || 0,
      });
    }
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      findAttachments(part, attachments);
    }
  }

  return attachments;
}

// Parse receipt fields from text (reuses OCR-style logic)
function parseReceiptFields(text) {
  const result = { vendor: null, amount: null, date: null };
  if (!text) return result;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Amount parsing: find "Total" (not Subtotal), then fallback to largest amount
  // Step 1: Look for lines with "total" but NOT "subtotal"
  for (const line of lines) {
    if (/subtotal/i.test(line)) continue;
    const m = line.match(/total[:\s]*\$?\s*([\d,]+\.\d{2})/i);
    if (m) {
      result.amount = parseFloat(m[1].replace(/,/g, ''));
      break;
    }
  }

  // Step 2: Look for labeled amounts (amount due, charged, paid)
  if (!result.amount) {
    for (const line of lines) {
      const m = line.match(/(?:amount due|amount charged|charged|you paid|payment of)[:\s]*\$?\s*([\d,]+\.\d{2})/i);
      if (m) {
        result.amount = parseFloat(m[1].replace(/,/g, ''));
        break;
      }
    }
  }

  // Step 3: Fallback - collect all dollar amounts, pick the largest
  if (!result.amount) {
    const allAmounts = [];
    for (const line of lines) {
      const matches = line.matchAll(/\$\s*([\d,]+\.\d{2})/g);
      for (const m of matches) {
        const val = parseFloat(m[1].replace(/,/g, ''));
        if (val > 0) allAmounts.push(val);
      }
    }
    if (allAmounts.length > 0) {
      result.amount = Math.max(...allAmounts);
    }
  }

  // Date: look for common date formats
  const datePatterns = [
    /(?:date|purchased|ordered|transaction|payment date)[:\s]*([\w\s,]+\d{4})/i,
    /(?:date|purchased|ordered|transaction|payment date)[:\s]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
    /(\w+\s+\d{1,2},?\s+\d{4})/,
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/,
  ];
  for (const pat of datePatterns) {
    for (const line of lines) {
      const m = line.match(pat);
      if (m) {
        const parsed = new Date(m[1]);
        if (!isNaN(parsed.getTime())) {
          result.date = parsed.toISOString().split('T')[0];
          break;
        }
      }
    }
    if (result.date) break;
  }

  return result;
}

// Determine document type from subject line
function classifyType(subject) {
  if (!subject) return 'Receipt';
  for (const { pattern, type } of TYPE_MAP) {
    if (pattern.test(subject)) return type;
  }
  return 'Receipt';
}

// ── Sender Rule Checks ──────────────────────────────────────────────────

function isSenderBlocked(userId, senderEmail) {
  const email = senderEmail.toLowerCase();

  // Check default-blocked domains first (global, no DB lookup)
  const domain = email.split('@')[1] || '';
  if (DEFAULT_BLOCKED_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) {
    return true;
  }

  // Then check user's custom rules
  const rule = getDb().prepare(
    'SELECT action FROM gmail_sender_rules WHERE user_id = ? AND sender_email = ?'
  ).get(userId, email);
  return rule && rule.action === 'block';
}

// ── Vendor Name Normalization ────────────────────────────────────────────
// Strip ".com" etc. so "Walmart.com" becomes "Walmart",
// matching manually scanned in-store receipts.

function normalizeVendor(name) {
  if (!name) return name;
  return name
    .replace(/\.(com|net|org|co|io|us|biz)$/i, '')  // strip TLDs
    .replace(/^(www\.)/i, '')                         // strip www.
    .trim();
}

// ── Payment Processor Prefix Stripping ──────────────────────────────────
// Card processor codes like "DD *DOORDASH", "SQ *COFFEESHOP", "TST* RESTAURANT"
// appear in Venmo/bank subjects. Strip the prefix to get the real vendor name.

// Extract payment amount from raw HTML when text body is useless
// Handles HTML-only emails like Xfinity that have "Please enable HTML" as plaintext
function extractAmountFromHtml(html) {
  if (!html) return null;
  const patterns = [
    /payment\s*amount[:\s]*(?:&nbsp;|\s)*\$([\d,]+\.\d{2})/i,
    /amount\s*(?:due|paid|charged)[:\s]*(?:&nbsp;|\s)*\$([\d,]+\.\d{2})/i,
    /total\s*(?:due|paid|charged)[:\s]*(?:&nbsp;|\s)*\$([\d,]+\.\d{2})/i,
    /(?:payment|billing)\s*(?:of|for)[:\s]*(?:&nbsp;|\s)*\$([\d,]+\.\d{2})/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
}

function stripProcessorPrefix(name) {
  if (!name) return name;
  return name
    .replace(/^(DD|SQ|TST|PAY)\s*\*\s*/i, '')  // "DD *DOORDASH" → "DOORDASH"
    .replace(/^\*\s*/, '')                        // leading * remnants
    .trim();
}

// ── Venmo Email Parsing ─────────────────────────────────────────────────
// Venmo sends several email types:
//   "You paid [Name] $XX.XX"           → outgoing payment
//   "[Name] paid you $XX.XX"           → incoming payment
//   "Cash back for your purchase at X" → cashback notification (debit card)
//
// The body contains a "for" note (what the sender typed as the purpose),
// which often names the real vendor (e.g., "DoorDash", "rent", "pizza").

function parseVenmoEmail(subject, bodyText) {
  const result = {
    vendor: null,      // resolved vendor name for the document
    forNote: null,     // the "for" description from the payment
    typeOverride: null, // override document type (e.g., Check for incoming)
    realVendor: null,  // the actual vendor for dedup (stripped of processor prefix)
  };

  // Pattern 1: "Cash back for your purchase at DD *DOORDASH"
  const cashbackMatch = subject.match(/cash\s*back\s+for\s+your\s+purchase\s+at\s+(.+)/i);
  if (cashbackMatch) {
    const raw = cashbackMatch[1].trim();
    const cleaned = stripProcessorPrefix(raw);
    // Cashback is a refund-like credit, vendor is the merchant
    result.vendor = `Venmo · ${cleaned}`;
    result.realVendor = cleaned;
    result.typeOverride = 'Refund';
    return result;
  }

  // Pattern 2: "You paid [Name] $XX.XX"
  const paidMatch = subject.match(/you\s+paid\s+(.+?)\s+\$[\d,.]+/i);
  if (paidMatch) {
    const recipient = paidMatch[1].trim();
    result.vendor = `Venmo · ${recipient}`;
  }

  // Pattern 3: "[Name] paid you $XX.XX"
  const receivedMatch = subject.match(/(.+?)\s+paid\s+you\s+\$[\d,.]+/i);
  if (receivedMatch && !paidMatch) {
    const sender = receivedMatch[1].trim();
    result.vendor = `Venmo · ${sender}`;
    result.typeOverride = 'Check'; // incoming money
  }

  // Pattern 4: "You completed a payment of $XX.XX"
  if (!result.vendor) {
    const completedMatch = subject.match(/completed\s+a\s+payment/i);
    if (completedMatch) {
      result.vendor = 'Venmo';
    }
  }

  // Pattern 5: "Receipt from [MERCHANT] - $XX.XX" (Venmo debit card purchases)
  const receiptFromMatch = subject.match(/receipt\s+from\s+(.+?)\s*-\s*\$[\d,.]+/i);
  if (receiptFromMatch && !result.vendor) {
    const merchant = stripProcessorPrefix(receiptFromMatch[1].trim());
    result.vendor = `Venmo · ${merchant}`;
    result.realVendor = merchant;
  }

  // Extract "for" note from body
  // Venmo email bodies (after HTML strip) typically have the note on its own line
  // after the amount, before the footer links. Common patterns:
  //   "- DoorDash"
  //   "For: rent"
  //   just a line by itself between the amount and "View on Venmo"
  if (bodyText) {
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);

    // Try explicit "for" label first
    for (const line of lines) {
      // Match lines like "for DoorDash" or "For: pizza money" but not "for more details"
      const forMatch = line.match(/^(?:for|note)\s*[:：]?\s+(.+)/i);
      if (forMatch) {
        const note = forMatch[1].trim();
        // Skip generic/navigational phrases
        if (note.length < 80 &&
            !/^(more\s+details|your\s+records|questions|help|support|any\s+questions)/i.test(note)) {
          result.forNote = note;
          break;
        }
      }
    }

    // Try finding the note between amount and footer
    // Look for a line with just a dollar amount, then grab what follows
    if (!result.forNote) {
      for (let i = 0; i < lines.length - 1; i++) {
        if (/^\$[\d,.]+$/.test(lines[i]) || /^-\s*\$[\d,.]+$/.test(lines[i])) {
          // The next non-empty line might be the note
          const candidate = lines[i + 1];
          if (candidate &&
              candidate.length < 80 &&
              !/^(view|manage|venmo|help|©|unsubscribe|privacy)/i.test(candidate) &&
              !/^https?:\/\//i.test(candidate) &&
              !/^\d+$/.test(candidate)) {
            result.forNote = candidate.replace(/^[-–—]\s*/, '').trim(); // strip leading dash
            break;
          }
        }
      }
    }

    // If we found a "for" note, use it to enrich the vendor name
    if (result.forNote && result.vendor) {
      const cleanNote = stripProcessorPrefix(result.forNote);
      // If the note looks like a business name (not a personal message), use it
      if (cleanNote.length < 40 && !/\s{2,}/.test(cleanNote)) {
        result.realVendor = cleanNote;
        // Append the real destination to the vendor
        // "Venmo · Emily" becomes "Venmo · Emily (DoorDash)"
        if (!result.vendor.toLowerCase().includes(cleanNote.toLowerCase())) {
          result.vendor = `${result.vendor} (${cleanNote})`;
        }
      }
    }
  }

  // Default vendor if nothing matched
  if (!result.vendor) {
    result.vendor = 'Venmo';
  }

  return result;
}

// ── DoorDash Email Parsing ──────────────────────────────────────────────
// DoorDash sends order confirmations with restaurant names in subject or body.
// Format title as "DD, [restaurant], $total" per user preference.

function parseDoorDashEmail(subject, bodyText) {
  const result = { restaurant: null };

  // Subject patterns:
  //   "Your order from [Restaurant] is confirmed"
  //   "Order from [Restaurant]"
  //   "Your [Restaurant] order is on its way" (would be skipped as tracking)
  //   "Delivery order from [Restaurant]"
  const subjectPatterns = [
    /(?:order|delivery)\s+from\s+(.+?)(?:\s+is\s|\s+has\s|\s*-\s*|\s*$)/i,
    /your\s+(.+?)\s+order/i,
  ];

  for (const pat of subjectPatterns) {
    const m = subject.match(pat);
    if (m) {
      const name = m[1].trim();
      // Filter out generic words that aren't restaurant names
      if (name.toLowerCase() !== 'doordash' && name.length < 50) {
        result.restaurant = name;
        break;
      }
    }
  }

  // Try body if subject didn't have it
  if (!result.restaurant && bodyText) {
    const bodyPatterns = [
      /(?:order|delivery)\s+from\s+(.+?)(?:\n|$)/im,
      /restaurant\s*[:：]\s*(.+?)(?:\n|$)/im,
    ];
    for (const pat of bodyPatterns) {
      const m = bodyText.match(pat);
      if (m) {
        const name = m[1].trim();
        if (name.length < 50) {
          result.restaurant = name;
          break;
        }
      }
    }
  }

  return result;
}

// ── Owner Resolution ────────────────────────────────────────────────────
// document_owners links to owners table (Norm, Emily, etc.), not users.
// Match user's display_name to owners.name.

function resolveOwnerId(user) {
  const owner = getDb().prepare(
    'SELECT id FROM owners WHERE LOWER(name) = LOWER(?)'
  ).get(user.display_name);
  return owner ? owner.id : null;
}

// ── Core Scan Logic ─────────────────────────────────────────────────────

async function processMessage(gmail, user, messageId) {
  // Check if already processed
  const existing = getDb().prepare(
    'SELECT id FROM gmail_processed WHERE user_id = ? AND message_id = ?'
  ).get(user.id, messageId);
  if (existing) return { status: 'duplicate' };

  // Fetch full message
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const headers = msg.data.payload.headers || [];
  let subject = getHeader(headers, 'Subject') || '(no subject)';
  const from = getHeader(headers, 'From') || '';
  const dateHeader = getHeader(headers, 'Date') || '';
  const senderEmail = extractSenderEmail(from);
  const senderName = extractSenderName(from);
  const emailDate = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

  // Strip Fw:/Fwd:/Re: prefixes (forwarded emails are duplicates)
  subject = subject.replace(/^(fw|fwd|re):\s*/gi, '').trim();

  // Content-based dedup: if we already have a doc with the same subject (after Fw/Re strip)
  // from the same sender ON THE SAME DAY, skip it (catches forwarded copies)
  // Different days = different orders (recurring Marco's, Walmart subscriptions)
  const emailDay = emailDate.split('T')[0]; // just the date portion
  const contentDup = getDb().prepare(`
    SELECT id FROM gmail_processed
    WHERE user_id = ? AND sender = ? AND subject = ?
      AND DATE(email_date) = ? AND status = 'processed'
  `).get(user.id, senderEmail, subject, emailDay);
  if (contentDup) {
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'duplicate content (Fw/Re)')
    `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
    return { status: 'duplicate' };
  }

  // Check sender blacklist (includes DEFAULT_BLOCKED_DOMAINS)
  if (isSenderBlocked(user.id, senderEmail)) {
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'blocked sender')
    `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
    return { status: 'blocked' };
  }

  // Skip obvious tracking/status update emails that aren't actual receipts
  const subjectLower = subject.toLowerCase();
  const SKIP_SUBJECTS = [
    'baking', 'constructing', 'on the way', 'out for delivery',
    'should arrive by', 'review your recent', 'review your order updates',
    'econfirm', 'rate your', 'how was your', 'leave a review',
    'track your', 'is on its way', 'delivered:',
  ];
  if (SKIP_SUBJECTS.some(s => subjectLower.includes(s))) {
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'tracking/status email')
    `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
    return { status: 'skipped', reason: 'tracking/status email' };
  }

  // Find attachments and body text
  const attachments = findAttachments(msg.data.payload);
  const bodyText = extractBodyText(msg.data.payload);

  // ── Vendor-specific parsing ────────────────────────────────────────
  // Runs before generic vendor resolution. Each parser can set overrides
  // for vendor name, document type, and title format.

  const senderDomain = (senderEmail.split('@')[1] || '').toLowerCase();
  let vendorOverride = null;
  let typeOverride = null;
  let titleOverride = null;
  let venmoData = null;
  let doordashData = null;

  // Venmo: parse "for" note, extract real vendor for dedup
  if (senderDomain === 'venmo.com' || senderEmail.includes('venmo')) {
    venmoData = parseVenmoEmail(subject, bodyText);
    if (venmoData.vendor) vendorOverride = venmoData.vendor;
    if (venmoData.typeOverride) typeOverride = venmoData.typeOverride;
  }

  // DoorDash: extract restaurant name for title formatting
  if (senderDomain === 'doordash.com' || senderEmail.includes('doordash')) {
    doordashData = parseDoorDashEmail(subject, bodyText);
    // vendorOverride stays null; we'll handle the title in buildTitle
  }

  // Sender-based overrides (Cinch Auto, etc.)
  const senderOverride = SENDER_OVERRIDES[senderDomain];
  if (senderOverride) {
    if (senderOverride.vendor) vendorOverride = senderOverride.vendor;
    if (senderOverride.type) typeOverride = senderOverride.type;
  }

  // ── Determine document type ────────────────────────────────────────
  const typeName = typeOverride || classifyType(subject);
  const typeRow = getDb().prepare('SELECT id FROM document_types WHERE name = ?').get(typeName);
  const typeId = typeRow ? typeRow.id : null;

  if (!typeId) {
    console.warn(`[Gmail Scanner] No type_id found for "${typeName}", skipping`);
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'no document type')
    `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
    return { status: 'skipped', reason: 'no document type' };
  }

  // Get the gmail-scan tag
  const tagRow = getDb().prepare('SELECT id FROM tags WHERE name = ?').get('gmail-scan');

  // ── Try JSON-LD structured data first ──────────────────────────────
  // Retailers like Walmart, Amazon, Target embed schema.org Order data
  // as JSON-LD in their HTML emails. This gives us clean parsed fields.
  const rawHtml = extractRawHtml(msg.data.payload);
  const jsonLdBlocks = rawHtml ? extractJsonLd(rawHtml) : null;
  const schemaData = jsonLdBlocks ? parseSchemaData(jsonLdBlocks) : null;

  // Resolve vendor: override > schema data > alias learning > sender name
  let vendorName = vendorOverride || senderName || senderEmail.split('@')[0];
  if (!vendorOverride) {
    if (schemaData && schemaData.vendor) {
      vendorName = schemaData.vendor;
    }
    const alias = getDb().prepare(
      'SELECT corrected_name FROM vendor_aliases WHERE LOWER(ocr_text) = LOWER(?)'
    ).get(vendorName);
    if (alias) vendorName = alias.corrected_name;

    // Normalize: "Walmart.com" → "Walmart"
    vendorName = normalizeVendor(vendorName);
  }

  // Subject-based vendor extraction for payment apps and brokerages
  // "You spent $36.12 at Chevron" → "Cash App · Chevron"
  // "You paid $X to [Person]" → "Cash App · [Person]"
  // Skip if we already have a vendor override (Venmo, Cinch, etc.)
  if (!vendorOverride) {
    const atMatch = subject.match(/(?:you\s+(?:spent|paid))\s+\$[\d,.]+\s+(?:at|to)\s+(.+)/i);
    if (atMatch) {
      const destination = atMatch[1].trim();
      vendorName = `${vendorName} · ${destination}`;
    }
  }

  // ── Parse receipt fields (MUST be before sold/bought body matching) ──
  const parsed = parseReceiptFields(bodyText);
  if (schemaData) {
    if (schemaData.amount != null) parsed.amount = schemaData.amount;
    if (schemaData.date) parsed.date = schemaData.date;
  }

  // HTML fallback: when text body is useless (e.g., "Please enable HTML"),
  // try extracting amount directly from raw HTML (Xfinity, similar senders)
  if (!parsed.amount && rawHtml) {
    const htmlAmount = extractAmountFromHtml(rawHtml);
    if (htmlAmount) {
      parsed.amount = htmlAmount;
      console.log('[Gmail Scanner] HTML fallback: extracted amount $' + htmlAmount + ' from raw HTML');
    }
  }

  // Body-based enrichment for investment/brokerage emails
  // Stash: "You sold $20.57 of US Treasury Income" → title shows sold + investment name
  if (!vendorOverride) {
    const soldMatch = bodyText.match(/you\s+sold\s+\$([\d,.]+)\s+of\s+(.+?)(?:\s+Whenever|\s*$)/im);
    const boughtMatch = bodyText.match(/you\s+(?:bought|purchased)\s+\$([\d,.]+)\s+of\s+(.+?)(?:\s+Whenever|\s*$)/im);
    if (soldMatch) {
      const investmentName = soldMatch[2].trim();
      vendorName = `${vendorName} · Sold ${investmentName}`;
      if (!parsed.amount) parsed.amount = parseFloat(soldMatch[1].replace(/,/g, ''));
    } else if (boughtMatch) {
      const investmentName = boughtMatch[2].trim();
      vendorName = `${vendorName} · Bought ${investmentName}`;
      if (!parsed.amount) parsed.amount = parseFloat(boughtMatch[1].replace(/,/g, ''));
    }
  }

  // Build notes: clean schema format when available, text fallback otherwise
  let fullNotes;
  if (schemaData && !schemaData.minimal) {
    fullNotes = formatSchemaOrder(schemaData, from, emailDate, subject);
    console.log(`[Gmail Scanner] JSON-LD parsed: ${vendorName} ${schemaData.items.length} items`);
  } else {
    const notesHeader = [
      `📧 Gmail ${typeName}`,
      `From: ${from}`,
      `Date: ${new Date(emailDate).toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}`,
      `Subject: ${subject}`,
      '---',
    ].join('\n');
    const trimmedBody = bodyText.length > 3000
      ? bodyText.substring(0, 3000) + '\n... (truncated)'
      : bodyText;
    fullNotes = notesHeader + '\n' + trimmedBody;
  }

  // ── Build document title ────────────────────────────────────────────
  function buildTitle(vendor, amount, typeName, subject) {
    // DoorDash special format: "DD · [restaurant] · $total"
    if (doordashData) {
      const parts = ['DD'];
      if (doordashData.restaurant) parts.push(doordashData.restaurant);
      if (amount != null) parts.push(`$${parseFloat(amount).toFixed(2)}`);
      return parts.join(' · ');
    }

    const parts = [vendor || 'Unknown'];
    if (amount != null) parts.push(`$${parseFloat(amount).toFixed(2)}`);
    if (typeName && typeName !== 'Receipt') parts.push(typeName);
    const title = parts.join(' · ');
    // If we only have vendor name and nothing else, append a hint from subject
    if (!amount && typeName === 'Receipt') {
      // Take first meaningful chunk of subject (strip Fw:/Re: prefixes)
      const cleanSubj = subject.replace(/^(fw|fwd|re):\s*/gi, '').trim();
      if (cleanSubj && cleanSubj.toLowerCase() !== vendor.toLowerCase()) {
        return `${vendor} · ${cleanSubj.substring(0, 50)}`;
      }
    }
    return title;
  }

  const docTitle = titleOverride || buildTitle(vendorName, parsed.amount, typeName, subject);

  // ── Venmo dedup against actual vendor receipts ──────────────────────
  // If this is a Venmo payment and the "for" note mentions a vendor,
  // check if a receipt from that vendor already exists for the same amount
  // on the same day. If so, skip (it's the same transaction).
  if (venmoData && venmoData.realVendor && parsed.amount) {
    const realVendorLower = venmoData.realVendor.toLowerCase();
    const docDate = parsed.date || emailDate.split('T')[0];
    const vendorReceipt = getDb().prepare(`
      SELECT id FROM documents
      WHERE amount = ?
        AND document_date = ?
        AND LOWER(vendor) LIKE ?
        AND id NOT IN (
          SELECT document_id FROM document_tags dt
          JOIN tags t ON dt.tag_id = t.id
          WHERE t.name = 'gmail-scan'
            AND document_id IS NOT NULL
        )
    `).get(parsed.amount, docDate, `%${realVendorLower}%`);

    if (vendorReceipt) {
      console.log(`[Gmail Scanner] Venmo dedup: skipping ${vendorName} $${parsed.amount} (matches vendor receipt ${vendorReceipt.id})`);
      getDb().prepare(`
        INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
        VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'venmo dedup: matching vendor receipt exists')
      `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
      return { status: 'duplicate', reason: 'venmo dedup against vendor receipt' };
    }

    // Also check gmail-scanned docs from the actual vendor (e.g., DoorDash sent its own receipt)
    const gmailVendorReceipt = getDb().prepare(`
      SELECT id FROM documents
      WHERE amount = ?
        AND document_date = ?
        AND LOWER(vendor) LIKE ?
        AND LOWER(vendor) NOT LIKE '%venmo%'
    `).get(parsed.amount, docDate, `%${realVendorLower}%`);

    if (gmailVendorReceipt) {
      console.log(`[Gmail Scanner] Venmo dedup: skipping ${vendorName} $${parsed.amount} (matches gmail vendor receipt)`);
      getDb().prepare(`
        INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
        VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'venmo dedup: matching vendor receipt exists')
      `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
      return { status: 'duplicate', reason: 'venmo dedup against vendor receipt' };
    }
  }

  // Document-level dedup: prevent duplicates even after rescan clears tracking
  // Checks ALL documents (manual uploads + gmail scans) for same vendor + amount + date
  const existingDoc = getDb().prepare(`
    SELECT id FROM documents
    WHERE LOWER(vendor) = LOWER(?)
      AND amount = ?
      AND document_date = ?
  `).get(
    vendorName,
    parsed.amount || null,
    parsed.date || emailDate.split('T')[0]
  );
  if (existingDoc) {
    // Record as processed so regular scans skip it, but don't create a new doc
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, document_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', 'document already exists')
    `).run(user.id, messageId, msg.data.threadId, existingDoc.id, subject, senderEmail, emailDate);
    return { status: 'duplicate', reason: 'document already exists' };
  }

  // Resolve owner for document_owners
  const ownerId = resolveOwnerId(user);

  let documentId = null;

  if (attachments.length > 0) {
    // ── Path A: Has attachments (PDF/images) ──
    // Download first attachment to use as the document's file_path

    const firstAtt = attachments[0];
    let primaryFilePath = null;
    let primaryOriginalName = null;
    let primaryMime = null;
    let primarySize = 0;

    try {
      const attData = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: messageId,
        id: firstAtt.attachmentId,
      });

      const fileBuffer = Buffer.from(attData.data.data, 'base64url');
      const ext = firstAtt.mimeType.includes('pdf') ? '.pdf'
        : firstAtt.mimeType.includes('png') ? '.png'
        : firstAtt.mimeType.includes('webp') ? '.webp'
        : '.jpg';
      const storedName = `${crypto.randomUUID()}${ext}`;
      primaryFilePath = storedName;
      primaryOriginalName = firstAtt.filename;
      primaryMime = firstAtt.mimeType;
      primarySize = fileBuffer.length;

      fs.writeFileSync(path.join(UPLOAD_PATH, storedName), fileBuffer);

      // Generate thumbnail for images
      if (!firstAtt.mimeType.includes('pdf')) {
        try {
          await generateThumbnail(
            path.join(UPLOAD_PATH, storedName),
            path.join(THUMBNAIL_PATH, `${storedName}.webp`)
          );
        } catch (e) {
          console.warn(`[Gmail Scanner] Thumbnail failed for ${storedName}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`[Gmail Scanner] First attachment download failed:`, e.message);
      // Can't create document without file_path, skip
      getDb().prepare(`
        INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
        VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'attachment download failed')
      `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
      return { status: 'skipped', reason: 'attachment download failed' };
    }

    // Create document
    documentId = crypto.randomUUID();
    const thumbnailRel = primaryMime && !primaryMime.includes('pdf')
      ? `${primaryFilePath}.webp` : null;

    getDb().prepare(`
      INSERT INTO documents (id, title, type_id, uploaded_by, file_path, thumbnail_path,
        original_filename, mime_type, file_size, vendor, amount, document_date, notes, ocr_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
    `).run(
      documentId, docTitle, typeId, user.id,
      primaryFilePath, thumbnailRel,
      primaryOriginalName, primaryMime, primarySize,
      vendorName, parsed.amount || null,
      parsed.date || emailDate.split('T')[0],
      fullNotes
    );

    // Create attachment record for primary file
    getDb().prepare(`
      INSERT INTO document_attachments (id, document_id, file_path, thumbnail_path, original_filename, mime_type, file_size, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      crypto.randomUUID(), documentId,
      primaryFilePath, thumbnailRel,
      primaryOriginalName, primaryMime, primarySize
    );

    // Download additional attachments (2nd, 3rd, etc.)
    for (let i = 1; i < attachments.length; i++) {
      const att = attachments[i];
      try {
        const attData = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: messageId,
          id: att.attachmentId,
        });

        const fileBuffer = Buffer.from(attData.data.data, 'base64url');
        const ext = att.mimeType.includes('pdf') ? '.pdf'
          : att.mimeType.includes('png') ? '.png'
          : att.mimeType.includes('webp') ? '.webp'
          : '.jpg';
        const storedName = `${crypto.randomUUID()}${ext}`;

        fs.writeFileSync(path.join(UPLOAD_PATH, storedName), fileBuffer);

        let thumbPath = null;
        if (!att.mimeType.includes('pdf')) {
          try {
            thumbPath = `${storedName}.webp`;
            await generateThumbnail(
              path.join(UPLOAD_PATH, storedName),
              path.join(THUMBNAIL_PATH, thumbPath)
            );
          } catch (e) {
            thumbPath = null;
            console.warn(`[Gmail Scanner] Thumbnail failed for ${storedName}:`, e.message);
          }
        }

        getDb().prepare(`
          INSERT INTO document_attachments (id, document_id, file_path, thumbnail_path, original_filename, mime_type, file_size, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          crypto.randomUUID(), documentId,
          storedName, thumbPath,
          att.filename, att.mimeType, fileBuffer.length, i
        );
      } catch (e) {
        console.error(`[Gmail Scanner] Attachment ${i} download failed:`, e.message);
      }
    }

    // Run OCR on primary image (not PDFs) to refine parsed fields
    if (primaryMime && !primaryMime.includes('pdf')) {
      try {
        const ocrText = extractText(path.join(UPLOAD_PATH, primaryFilePath));
        if (ocrText) {
          const ocrParsed = parseReceiptFields(ocrText);

          const updates = [];
          const vals = [];

          updates.push('ocr_text = ?', "ocr_status = 'complete'");
          vals.push(ocrText);

          if (ocrParsed.amount && !parsed.amount) {
            updates.push('amount = ?');
            vals.push(ocrParsed.amount);
          }
          if (ocrParsed.vendor) {
            const ocrAlias = getDb().prepare(
              'SELECT corrected_name FROM vendor_aliases WHERE LOWER(ocr_text) = LOWER(?)'
            ).get(ocrParsed.vendor);
            if (ocrAlias) {
              updates.push('vendor = ?');
              vals.push(ocrAlias.corrected_name);
            }
          }

          vals.push(documentId);
          getDb().prepare(`UPDATE documents SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
        }
      } catch (e) {
        console.warn(`[Gmail Scanner] OCR failed:`, e.message);
      }
    }

  } else if (bodyText.trim()) {
    // ── Path B: Body-only receipt (no attachment) ──
    // documents.file_path is NOT NULL, so save the email body as a .txt file

    const storedName = `${crypto.randomUUID()}.txt`;
    fs.writeFileSync(path.join(UPLOAD_PATH, storedName), fullNotes, 'utf-8');

    documentId = crypto.randomUUID();
    getDb().prepare(`
      INSERT INTO documents (id, title, type_id, uploaded_by, file_path,
        original_filename, mime_type, file_size, vendor, amount, document_date, notes,
        ocr_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?, 'complete', datetime('now'), datetime('now'))
    `).run(
      documentId, docTitle, typeId, user.id,
      storedName,
      `${vendorName.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50)}.txt`,
      Buffer.byteLength(fullNotes, 'utf-8'),
      vendorName, parsed.amount || null,
      parsed.date || emailDate.split('T')[0],
      fullNotes
    );

  } else {
    // No attachment AND no body text: skip
    getDb().prepare(`
      INSERT INTO gmail_processed (user_id, message_id, thread_id, subject, sender, email_date, status, skip_reason)
      VALUES (?, ?, ?, ?, ?, ?, 'skipped', 'no content')
    `).run(user.id, messageId, msg.data.threadId, subject, senderEmail, emailDate);
    return { status: 'skipped', reason: 'no content' };
  }

  // Assign owner (match user's display_name to owners table)
  if (ownerId) {
    getDb().prepare('INSERT OR IGNORE INTO document_owners (document_id, owner_id) VALUES (?, ?)')
      .run(documentId, ownerId);
  }

  // Tag with gmail-scan
  if (tagRow) {
    getDb().prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)')
      .run(documentId, tagRow.id);
  }

  // Vendor tag learning: copy tags from the most recent document with the same vendor
  // So if you tagged a Walmart receipt "groceries", the next Walmart scan gets "groceries" too
  if (vendorName) {
    const prevDoc = getDb().prepare(`
      SELECT d.id FROM documents d
      JOIN document_tags dt ON d.id = dt.document_id
      JOIN tags t ON dt.tag_id = t.id
      WHERE LOWER(d.vendor) = LOWER(?) AND d.id != ? AND t.name != 'gmail-scan'
      ORDER BY d.created_at DESC LIMIT 1
    `).get(vendorName, documentId);

    if (prevDoc) {
      const prevTags = getDb().prepare(`
        SELECT t.id FROM document_tags dt
        JOIN tags t ON dt.tag_id = t.id
        WHERE dt.document_id = ? AND t.name != 'gmail-scan'
      `).all(prevDoc.id);

      for (const t of prevTags) {
        getDb().prepare('INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)')
          .run(documentId, t.id);
      }
      if (prevTags.length > 0) {
        console.log(`[Gmail Scanner] Vendor tags learned: ${vendorName} → ${prevTags.length} tags`);
      }
    }
  }

  // Record as processed
  getDb().prepare(`
    INSERT INTO gmail_processed (user_id, message_id, thread_id, document_id, subject, sender, email_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processed')
  `).run(user.id, messageId, msg.data.threadId, documentId, subject, senderEmail, emailDate);

  // Activity log entry
  getDb().prepare(`
    INSERT INTO activity_log (id, user_id, action, detail, document_id, created_at)
    VALUES (?, ?, 'gmail_receipt', ?, ?, datetime('now'))
  `).run(
    crypto.randomUUID(),
    user.id,
    JSON.stringify({
      subject,
      vendor: vendorName,
      amount: parsed.amount,
      type: typeName,
      has_attachment: attachments.length > 0,
    }),
    documentId
  );

  return { status: 'created', documentId, subject, vendor: vendorName };
}

// ── Main Scan Function ──────────────────────────────────────────────────

async function scanUserGmail(user, scanType = 'scheduled') {
  // Concurrency guard
  if (activeScans.get(user.id)) {
    console.log(`[Gmail Scanner] Scan already running for user ${user.id}, skipping`);
    return null;
  }
  activeScans.set(user.id, true);

  // Create scan run record
  const run = getDb().prepare(`
    INSERT INTO gmail_scan_runs (user_id, scan_type, started_at, status)
    VALUES (?, ?, datetime('now'), 'running')
  `).run(user.id, scanType);
  const runId = run.lastInsertRowid;

  const stats = { found: 0, created: 0, duplicates: 0, errors: 0 };

  try {
    const gmail = createGmailClient(user);

    // Build time-scoped query
    let query = DEFAULT_QUERY;

    if (scanType === 'manual') {
      query += ' newer_than:7d';
    } else {
      // Scheduled: pick up from last completed scan
      const lastRun = getDb().prepare(`
        SELECT completed_at FROM gmail_scan_runs
        WHERE user_id = ? AND status = 'completed' AND scan_type IN ('scheduled', 'manual')
        ORDER BY completed_at DESC LIMIT 1
      `).get(user.id);

      if (lastRun && lastRun.completed_at) {
        const epoch = Math.floor(new Date(lastRun.completed_at).getTime() / 1000);
        query += ` after:${epoch}`;
      } else {
        query += ' newer_than:7d';
      }
    }

    // Search Gmail (paginated, capped at 200)
    let allMessageIds = [];
    let pageToken = null;

    do {
      const listParams = { userId: 'me', q: query, maxResults: 50 };
      if (pageToken) listParams.pageToken = pageToken;

      const res = await gmail.users.messages.list(listParams);
      if (res.data.messages) {
        allMessageIds.push(...res.data.messages.map(m => m.id));
      }
      pageToken = res.data.nextPageToken;

      if (allMessageIds.length >= 200) break;
    } while (pageToken);

    stats.found = allMessageIds.length;
    console.log(`[Gmail Scanner] Found ${stats.found} messages for user ${user.id} (${scanType})`);

    // Process each message
    for (const msgId of allMessageIds) {
      try {
        const result = await processMessage(gmail, user, msgId);
        if (result.status === 'created') stats.created++;
        else if (result.status === 'duplicate') stats.duplicates++;
      } catch (e) {
        stats.errors++;
        console.error(`[Gmail Scanner] Error processing message ${msgId}:`, e.message);
      }
    }

    // Update run record
    getDb().prepare(`
      UPDATE gmail_scan_runs
      SET completed_at = datetime('now'),
          messages_found = ?, documents_created = ?,
          duplicates_skipped = ?, errors = ?,
          status = 'completed'
      WHERE id = ?
    `).run(stats.found, stats.created, stats.duplicates, stats.errors, runId);

    // Activity log summary (only if documents were created)
    if (stats.created > 0) {
      getDb().prepare(`
        INSERT INTO activity_log (id, user_id, action, detail, created_at)
        VALUES (?, ?, 'gmail_scan_complete', ?, datetime('now'))
      `).run(
        crypto.randomUUID(),
        user.id,
        JSON.stringify({
          scan_type: scanType,
          found: stats.found,
          created: stats.created,
          duplicates: stats.duplicates,
          errors: stats.errors,
        })
      );
    }

    console.log(`[Gmail Scanner] Scan complete for user ${user.id}: ${stats.created} created, ${stats.duplicates} dupes, ${stats.errors} errors`);

  } catch (e) {
    console.error(`[Gmail Scanner] Scan failed for user ${user.id}:`, e.message);
    getDb().prepare(`
      UPDATE gmail_scan_runs
      SET completed_at = datetime('now'), status = 'failed', error_message = ?
      WHERE id = ?
    `).run(e.message, runId);
  } finally {
    activeScans.delete(user.id);
  }

  return stats;
}

// ── Scheduled Scan Runner ───────────────────────────────────────────────
// Called by cron every 15 minutes; gates to 7 AM - 10 PM Central

async function runScheduledScan() {
  const now = new Date();

  // Convert to Central time (America/Chicago)
  const centralTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour = centralTime.getHours();
  const minute = centralTime.getMinutes();

  // Only run between 7:00 AM and 10:00 PM Central
  if (hour < 7 || hour > 22) return;
  if (hour === 22 && minute > 0) return;

  console.log(`[Gmail Scanner] Scheduled scan starting (${centralTime.toLocaleTimeString()})`);

  // Find all users with linked Gmail
  const users = getDb().prepare(`
    SELECT * FROM users
    WHERE google_refresh_token IS NOT NULL
      AND google_scopes LIKE '%gmail.readonly%'
  `).all();

  for (const user of users) {
    try {
      await scanUserGmail(user, 'scheduled');
    } catch (e) {
      console.error(`[Gmail Scanner] Scheduled scan error for user ${user.id}:`, e.message);
    }
  }
}

// ── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  initGmailScanTables,
  scanUserGmail,
  runScheduledScan,
};
