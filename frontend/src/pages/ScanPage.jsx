import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { uploadDocument, getOwners, getTypes, ocrScanFile } from '../services/api';
import TagInput from '../components/TagInput';
import ImageEditor from '../components/ImageEditor';

export default function ScanPage() {
  const navigate = useNavigate();
  const [owners, setOwners] = useState([]);
  const [types, setTypes] = useState([]);
  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [editingIndex, setEditingIndex] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [ocrResult, setOcrResult] = useState(null);
  const fileInputRef = useRef(null);

  const [title, setTitle] = useState('');
  const [selectedOwners, setSelectedOwners] = useState([]);
  const [typeId, setTypeId] = useState('');
  const [documentDate, setDocumentDate] = useState('');
  const [expirationDate, setExpirationDate] = useState('');
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');

  useEffect(() => {
    Promise.all([getOwners(), getTypes()])
      .then(([o, t]) => { setOwners(o); setTypes(t); if (t.length > 0) setTypeId(t[0].id); })
      .catch(() => {});
  }, []);

  function toggleOwner(ownerId) {
    setSelectedOwners(prev =>
      prev.includes(ownerId) ? prev.filter(id => id !== ownerId) : [...prev, ownerId]
    );
  }

  function handleFileSelect(e) { addFiles(Array.from(e.target.files)); }

  function addFiles(newFiles) {
    setFiles(prev => [...prev, ...newFiles]);
    const newPreviews = newFiles.map(f => f.type.startsWith('image/') ? URL.createObjectURL(f) : null);
    setPreviews(prev => [...prev, ...newPreviews]);
  }

  function removeFile(index) {
    setFiles(prev => prev.filter((_, i) => i !== index));
    setPreviews(prev => { if (prev[index]) URL.revokeObjectURL(prev[index]); return prev.filter((_, i) => i !== index); });
  }

  function handleEditorSave(blob) {
    const editIdx = editingIndex;
    // Replace the file at editIdx with the cropped version
    const newFile = new File([blob], files[editIdx].name || 'edited.jpg', { type: 'image/jpeg' });
    setFiles(prev => prev.map((f, i) => i === editIdx ? newFile : f));
    // Replace the preview
    setPreviews(prev => {
      if (prev[editIdx]) URL.revokeObjectURL(prev[editIdx]);
      return prev.map((p, i) => i === editIdx ? URL.createObjectURL(blob) : p);
    });
    setEditingIndex(null);
  }

  async function handleOcrScan() {
    if (!files.length || !files[0].type.startsWith('image/')) return;
    setScanning(true);
    setOcrResult(null);
    try {
      const result = await ocrScanFile(files[0]);
      setOcrResult(result);
      if (result.suggestedTitle && !title) setTitle(result.suggestedTitle);
      if (result.vendor && !vendor) setVendor(result.vendor);
      if (result.amount && !amount) setAmount(String(result.amount));
      if (result.date && !documentDate) setDocumentDate(result.date);
      if (result.rawText) setNotes(result.rawText);
      setSuccess('OCR complete! Review the auto-filled fields.');
    } catch (err) {
      setError('OCR scan failed: ' + err.message);
    } finally {
      setScanning(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (files.length === 0) { setError('Snap a photo or pick a file first'); return; }
    if (!title.trim()) { setError('Give it a title'); return; }
    if (selectedOwners.length === 0) { setError('Pick at least one owner'); return; }
    if (!typeId) { setError('Pick a document type'); return; }

    setUploading(true);
    setError('');

    try {
      const formData = new FormData();
      files.forEach(f => formData.append('files', f));
      formData.append('title', title.trim());
      formData.append('owner_ids', JSON.stringify(selectedOwners));
      formData.append('type_id', typeId);
      if (documentDate) formData.append('document_date', documentDate);
      if (expirationDate) formData.append('expiration_date', expirationDate);
      if (amount) formData.append('amount', amount);
      if (vendor.trim()) formData.append('vendor', vendor.trim());
      if (notes.trim()) formData.append('notes', notes.trim());
      if (tags.trim()) formData.append('tags', JSON.stringify(tags.split(',').map(t => t.trim()).filter(Boolean)));

      const result = await uploadDocument(formData);
      setSuccess('Uploaded!');
      setFiles([]); setPreviews([]); setTitle(''); setSelectedOwners([]);
      setDocumentDate(''); setExpirationDate(''); setAmount(''); setVendor(''); setNotes(''); setTags('');

      setTimeout(() => {
        if (result.document) navigate('/doc/' + result.document.id);
        else navigate('/');
      }, 800);
    } catch (err) { setError(err.message); }
    finally { setUploading(false); }
  }

  return (
    <>
      <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '16px' }}>Scan or Upload</h2>

      <div style={{ background: 'var(--bg-surface)', borderRadius: 'var(--radius-md)', border: '2px dashed var(--border)', padding: '24px', textAlign: 'center', marginBottom: '20px' }}>
        {previews.length > 0 ? (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center', marginBottom: '12px' }}>
            {previews.map((url, i) => (
              <div key={i} style={{ position: 'relative' }}>
                {url ? (
                  <img src={url} alt="" style={{ width: '80px', height: '80px', objectFit: 'cover', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', cursor: 'pointer' }}
                    onClick={() => setEditingIndex(i)} title="Tap to crop/rotate" />
                ) : (
                  <div style={{ width: '80px', height: '80px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-elevated)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2rem' }}>PDF</div>
                )}
                <button onClick={() => removeFile(i)} style={{ position: 'absolute', top: '-6px', right: '-6px', background: 'var(--accent-red)', color: '#fff', border: 'none', borderRadius: '50%', width: '20px', height: '20px', fontSize: '0.7rem', cursor: 'pointer', lineHeight: '20px' }}>x</button>
                {url && (
                  <button onClick={() => setEditingIndex(i)} style={{ position: 'absolute', bottom: '-4px', right: '-4px', background: 'var(--accent-orange)', color: '#fff', border: 'none', borderRadius: '50%', width: '22px', height: '22px', fontSize: '0.65rem', cursor: 'pointer', lineHeight: '22px' }} title="Crop/Rotate">✂</button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ color: 'var(--text-dim)', marginBottom: '12px', fontSize: '2.5rem' }}>📷</div>
        )}

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" type="button" onClick={() => {
            const input = document.createElement('input');
            input.type = 'file'; input.accept = 'image/*'; input.capture = 'environment';
            input.onchange = (e) => addFiles(Array.from(e.target.files)); input.click();
          }}>📸 Take Photo</button>
          <button className="btn btn-secondary" type="button" onClick={() => fileInputRef.current?.click()}>📎 Choose File</button>
          <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple style={{ display: 'none' }} onChange={handleFileSelect} />
        </div>
        {files.length > 1 && (
          <div style={{ marginTop: '8px', fontSize: '0.8rem', color: 'var(--accent-green)' }}>
            {files.length} files selected (will be attached as pages to one document)
          </div>
        )}
      </div>

      {/* OCR Auto-fill */}
      {files.length > 0 && files[0].type?.startsWith('image/') && (
        <div style={{ marginBottom: '16px', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button className="btn btn-secondary" type="button" onClick={handleOcrScan} disabled={scanning}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {scanning ? (
              <><span className="spinner" style={{ width: '14px', height: '14px' }} /> Scanning...</>
            ) : (
              <>🔍 Auto-fill from scan</>
            )}
          </button>
          {ocrResult && (
            <span style={{ fontSize: '0.78rem', color: 'var(--accent-green)' }}>
              ✓ {ocrResult.rawText ? `${ocrResult.rawText.length} chars detected` : 'No text found'}
            </span>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Title *</label>
          <input type="text" value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. State Farm Auto Insurance Card" required />
        </div>

        <div className="form-group">
          <label>Owner(s) * <span style={{ fontWeight: 400, textTransform: 'none', fontSize: '0.75rem' }}>(select all that apply)</span></label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {owners.map(o => (
              <button key={o.id} type="button"
                className={`chip ${selectedOwners.includes(o.id) ? 'active' : ''}`}
                onClick={() => toggleOwner(o.id)}
                style={selectedOwners.includes(o.id) ? {} : { borderColor: o.color, color: o.color }}>
                {o.icon} {o.name}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>Type *</label>
          <select value={typeId} onChange={e => setTypeId(e.target.value)} required>
            {types.map(t => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}
          </select>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="form-group"><label>Document Date</label><input type="date" value={documentDate} onChange={e => setDocumentDate(e.target.value)} /></div>
          <div className="form-group"><label>Expiration Date</label><input type="date" value={expirationDate} onChange={e => setExpirationDate(e.target.value)} /></div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div className="form-group"><label>Amount ($)</label><input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" /></div>
          <div className="form-group"><label>Vendor / Source</label><input type="text" value={vendor} onChange={e => setVendor(e.target.value)} placeholder="e.g. State Farm" /></div>
        </div>

        <div className="form-group"><label>Tags</label><TagInput value={tags} onChange={setTags} /></div>
        <div className="form-group"><label>Notes</label><textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any extra notes..." rows={3} /></div>

        {error && <div style={{ background: 'rgba(255,87,87,0.1)', border: '1px solid rgba(255,87,87,0.3)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: '16px', fontSize: '0.85rem', color: 'var(--accent-red)' }}>{error}</div>}
        {success && <div style={{ background: 'rgba(58,217,142,0.1)', border: '1px solid rgba(58,217,142,0.3)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: '16px', fontSize: '0.85rem', color: 'var(--accent-green)' }}>{success}</div>}

        <button type="submit" className="btn btn-primary btn-block" disabled={uploading || files.length === 0}>
          {uploading ? 'Uploading...' : 'Upload' + (files.length > 0 ? ' (' + files.length + ' page' + (files.length > 1 ? 's' : '') + ')' : '')}
        </button>
      </form>

      {editingIndex !== null && previews[editingIndex] && (
        <ImageEditor
          imageSrc={previews[editingIndex]}
          onSave={handleEditorSave}
          onCancel={() => setEditingIndex(null)}
        />
      )}
    </>
  );
}
