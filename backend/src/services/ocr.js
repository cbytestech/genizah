// Genizah — OCR service (Tesseract, local)
// Runs tesseract directly on uploaded images, parses for vendor/amount/date.

const { execSync } = require('child_process');
const path = require('path');

// Run tesseract on an image and return raw text
function extractText(filePath) {
  try {
    // tesseract outputs to stdout with - as output file
    const output = execSync(
      `tesseract "${filePath}" stdout --psm 6 -l eng 2>/dev/null`,
      { timeout: 30000, maxBuffer: 1024 * 1024 }
    );
    return output.toString('utf-8').trim();
  } catch (err) {
    console.error('[Genizah OCR] Tesseract error:', err.message);
    return '';
  }
}

// Parse OCR text for common document fields
function parseOcrText(text) {
  const result = {
    vendor: null,
    amount: null,
    date: null,
    suggestedTitle: null,
    rawText: text
  };

  if (!text) return result;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // ── Amount detection ──
  // Priority 1: Look for amounts explicitly labeled as total/credit card/balance due
  const totalPatterns = [
    /(?:credit\s*card|debit\s*card|amount\s*charged|amount\s*paid|balance\s*due|amount\s*due|grand\s*total)[:\s]*\$?\s?([\d,]+\.\d{2})/gi,
    /(?:^|\s)total[:\s]*\$?\s?([\d,]+\.\d{2})/gim,
  ];

  let labeledTotal = null;
  for (const pattern of totalPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (val > 0 && val < 1000000) {
        // Take the LAST labeled total (on receipts, "Total" often appears after "Subtotal")
        labeledTotal = val;
      }
    }
  }

  if (labeledTotal !== null) {
    result.amount = labeledTotal;
  } else {
    // Fallback: grab all dollar amounts, take the last one (receipts end with the total)
    const fallbackPattern = /\$?\s?([\d,]+\.\d{2})/g;
    const allAmounts = [];
    let match;
    while ((match = fallbackPattern.exec(text)) !== null) {
      const val = parseFloat(match[1].replace(/,/g, ''));
      if (val > 0 && val < 1000000) allAmounts.push(val);
    }
    if (allAmounts.length > 0) {
      result.amount = allAmounts[allAmounts.length - 1];
    }
  }

  // ── Vendor detection ──
  // Priority 1: Look for labeled vendor lines
  const vendorPatterns = [
    /(?:pay\s*to(?:\s*the\s*order\s*of)?)[:\s]*(.+)/i,
    /(?:from|vendor|merchant|company|payee|store)[:\s]*(.+)/i,
    /(?:bill\s*to|sold\s*to|ship\s*to)[:\s]*(.+)/i
  ];

  for (const pattern of vendorPatterns) {
    const match = text.match(pattern);
    if (match) {
      result.vendor = match[1].trim().substring(0, 100);
      break;
    }
  }

  // Priority 2: First clean line that looks like a business name
  if (!result.vendor) {
    for (const line of lines.slice(0, 8)) {
      const cleaned = line.trim();
      // Skip short lines, lines that are mostly numbers/symbols, dates, dollar amounts
      if (cleaned.length < 3) continue;
      if (/^\d+[\/\-]/.test(cleaned)) continue;           // date
      if (/^\$/.test(cleaned)) continue;                    // dollar amount
      if (/^\d+\.\d{2}$/.test(cleaned)) continue;          // bare number
      if (/^[#*\-_=.]+$/.test(cleaned)) continue;          // separator line
      // Count letters vs non-letter chars; skip if mostly garbage
      const letters = (cleaned.match(/[a-zA-Z]/g) || []).length;
      if (letters < cleaned.length * 0.4) continue;        // less than 40% letters = garbage
      if (cleaned.length < 4 && !/[A-Z]/.test(cleaned)) continue;
      result.vendor = cleaned.substring(0, 100);
      break;
    }
  }

  // ── Date detection ──
  const datePatterns = [
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,     // MM/DD/YYYY or MM-DD-YYYY
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/,    // MM/DD/YY
    /(\w+)\s+(\d{1,2}),?\s+(\d{4})/,               // Month DD, YYYY
    /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/        // YYYY-MM-DD
  ];

  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const dateStr = match[0];
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime()) && parsed.getFullYear() > 2000 && parsed.getFullYear() < 2100) {
          result.date = parsed.toISOString().split('T')[0];
          break;
        }
        if (match[3] && match[3].length === 2) {
          const year = parseInt(match[3]) + 2000;
          const month = parseInt(match[1]);
          const day = parseInt(match[2]);
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
            result.date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            break;
          }
        }
      } catch (e) { /* try next pattern */ }
    }
  }

  // ── Vendor auto-correction ──
  if (result.vendor) {
    result.ocrVendor = result.vendor; // keep original for learning
    result.vendor = matchVendor(result.vendor);
  }

  // ── Suggested title ──
  if (result.vendor && result.date) {
    const shortDate = result.date.replace(/^\d{2}/, '').replace(/-/g, '/');
    result.suggestedTitle = result.vendor.substring(0, 50) + ' - ' + shortDate;
  } else if (result.vendor) {
    result.suggestedTitle = result.vendor.substring(0, 60);
  }

  return result;
}

// Full OCR pipeline: extract text, parse fields, update database
async function processDocument(documentId, filePath, mimeType) {
  // Only process images (not PDFs for now)
  if (!mimeType || !mimeType.startsWith('image/')) {
    updateOcrStatus(documentId, 'skipped', null);
    return null;
  }

  try {
    updateOcrStatus(documentId, 'processing', null);

    const rawText = extractText(filePath);

    if (!rawText) {
      updateOcrStatus(documentId, 'empty', null);
      return { rawText: '', vendor: null, amount: null, date: null };
    }

    const parsed = parseOcrText(rawText);
    updateOcrStatus(documentId, 'complete', rawText);

    console.log(`[Genizah OCR] Processed ${documentId}: ${rawText.length} chars, vendor=${parsed.vendor}, amount=${parsed.amount}, date=${parsed.date}`);
    return parsed;
  } catch (err) {
    console.error(`[Genizah OCR] Error for ${documentId}:`, err.message);
    updateOcrStatus(documentId, 'failed', null);
    return null;
  }
}

function updateOcrStatus(documentId, status, text) {
  try {
    const { getDb } = require('../models/database');
    const db = getDb();
    db.prepare(`
      UPDATE documents SET ocr_status = ?, ocr_text = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, text, documentId);
  } catch (err) {
    console.error(`[Genizah OCR] Failed to update status for ${documentId}:`, err.message);
  }
}

module.exports = { processDocument, extractText, parseOcrText, learnVendor, matchVendor };

// ── Vendor Learning ──
// Called when a document is saved with a vendor name that differs from OCR detection.
// Stores the mapping so future scans auto-correct.
function learnVendor(ocrVendor, correctedVendor) {
  if (!ocrVendor || !correctedVendor) return;
  const ocrNorm = ocrVendor.trim().toLowerCase();
  const corrected = correctedVendor.trim();
  if (ocrNorm === corrected.toLowerCase()) return; // no correction needed

  try {
    const { getDb } = require('../models/database');
    const db = getDb();

    const existing = db.prepare('SELECT * FROM vendor_aliases WHERE ocr_text = ?').get(ocrNorm);
    if (existing) {
      db.prepare(`UPDATE vendor_aliases SET corrected_name = ?, match_count = match_count + 1,
        updated_at = datetime('now') WHERE ocr_text = ?`).run(corrected, ocrNorm);
    } else {
      db.prepare('INSERT INTO vendor_aliases (ocr_text, corrected_name) VALUES (?, ?)').run(ocrNorm, corrected);
    }
    console.log(`[Genizah OCR] Learned vendor: "${ocrVendor}" -> "${corrected}"`);
  } catch (err) {
    console.error('[Genizah OCR] Failed to learn vendor:', err.message);
  }
}

// Check if an OCR vendor string matches a known alias (fuzzy).
// Returns the corrected name or the original if no match.
function matchVendor(ocrVendor) {
  if (!ocrVendor) return ocrVendor;

  try {
    const { getDb } = require('../models/database');
    const db = getDb();

    const norm = ocrVendor.trim().toLowerCase();

    // Exact match first
    const exact = db.prepare('SELECT corrected_name FROM vendor_aliases WHERE ocr_text = ?').get(norm);
    if (exact) return exact.corrected_name;

    // Fuzzy match: check all aliases for similarity
    const aliases = db.prepare('SELECT ocr_text, corrected_name FROM vendor_aliases ORDER BY match_count DESC').all();
    for (const alias of aliases) {
      if (similarity(norm, alias.ocr_text) > 0.7) {
        return alias.corrected_name;
      }
    }

    // Also check if the input closely matches any corrected_name directly
    // (user might scan a receipt that OCRs slightly differently each time)
    for (const alias of aliases) {
      if (similarity(norm, alias.corrected_name.toLowerCase()) > 0.75) {
        return alias.corrected_name;
      }
    }

    return ocrVendor;
  } catch (err) {
    return ocrVendor;
  }
}

// Simple similarity measure (Dice coefficient on bigrams)
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const bigramsA = new Set();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.substring(i, i + 2));

  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (bigramsA.has(b.substring(i, i + 2))) matches++;
  }

  const totalBigrams = (a.length - 1) + (b.length - 1);
  return (2 * matches) / totalBigrams;
}
