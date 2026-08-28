// Genizah — Thumbnail generation
// Creates preview thumbnails for uploaded documents

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const THUMB_SIZE = 400; // max dimension in pixels
const THUMB_PATH = process.env.THUMBNAIL_PATH || path.join(__dirname, '../../data/thumbnails');

async function generateThumbnail(filePath, docId, mimeType) {
  try {
    fs.mkdirSync(THUMB_PATH, { recursive: true });

    const thumbFilename = `${docId}.webp`;
    const thumbFullPath = path.join(THUMB_PATH, thumbFilename);

    if (mimeType === 'application/pdf') {
      // For PDFs, we'll generate thumbnails in a later phase
      // using pdf-poppler or similar. For now, return null.
      // The frontend will show a PDF icon placeholder.
      return null;
    }

    // Image thumbnail
    await sharp(filePath)
      .resize(THUMB_SIZE, THUMB_SIZE, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 80 })
      .toFile(thumbFullPath);

    return thumbFilename;
  } catch (err) {
    console.error(`[Genizah] Thumbnail error for ${docId}:`, err.message);
    return null;
  }
}

module.exports = { generateThumbnail };
