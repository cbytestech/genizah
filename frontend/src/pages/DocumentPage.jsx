import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getDocument, updateDocument, deleteDocument, getOwners, getTypes, deleteAttachment, deletePrimaryImage, replacePrimaryImage, replaceAttachment, ocrRescan } from '../services/api';
import TagInput from '../components/TagInput';
import ImageEditor from '../components/ImageEditor';

export default function DocumentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [doc, setDoc] = useState(null);
  const [owners, setOwners] = useState([]);
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showOcr, setShowOcr] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDeletePage, setConfirmDeletePage] = useState(null);
  const [editingImage, setEditingImage] = useState(false);
  const [toast, setToast] = useState('');
  const [activeImage, setActiveImage] = useState(0);
  const [uploading, setUploading] = useState(false);
  const addFileRef = useRef(null);

  const [editTitle, setEditTitle] = useState('');
  const [editOwnerIds, setEditOwnerIds] = useState([]);
  const [editTypeId, setEditTypeId] = useState('');
  const [editDocDate, setEditDocDate] = useState('');
  const [editExpDate, setEditExpDate] = useState('');
  const [editAmount, setEditAmount] = useState('');
  const [editVendor, setEditVendor] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editStatus, setEditStatus] = useState('');

  useEffect(() => {
    Promise.all([getDocument(id), getOwners(), getTypes()])
      .then(([d, o, t]) => { setDoc(d); setOwners(o); setTypes(t); populateEdit(d); })
      .catch(err => { console.error(err); navigate('/'); })
      .finally(() => setLoading(false));
  }, [id]);

  function populateEdit(d) {
    setEditTitle(d.title || '');
    setEditOwnerIds(d.owners && d.owners.length > 0 ? d.owners.map(o => o.id) : (d.owner_id ? [d.owner_id] : []));
    setEditTypeId(d.type_id || '');
    setEditDocDate(d.document_date ? d.document_date.slice(0, 10) : '');
    setEditExpDate(d.expiration_date ? d.expiration_date.slice(0, 10) : '');
    setEditAmount(d.amount != null ? String(d.amount) : '');
    setEditVendor(d.vendor || '');
    setEditNotes(d.notes || '');
    setEditTags(d.tags ? d.tags.join(', ') : '');
    setEditStatus(d.status || 'active');
  }

  // Build all images array: primary + attachments
  function getAllImages() {
    if (!doc) return [];
    const images = [{ file_path: doc.file_path, thumbnail_path: doc.thumbnail_path, mime_type: doc.mime_type, isPrimary: true }];
    if (doc.attachments) {
      doc.attachments.forEach(a => images.push({ ...a, isPrimary: false }));
    }
    return images;
  }

  async function handleAddPages(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setUploading(true);

    try {
      const token = localStorage.getItem('genizah_token');
      const formData = new FormData();
      files.forEach(f => formData.append('files', f));

      const res = await fetch(`/api/documents/${id}/attachments`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (!res.ok) throw new Error((await res.json()).error);

      // Reload document
      const fresh = await getDocument(id);
      setDoc(fresh);
      populateEdit(fresh);
      showToastMsg(`Added ${files.length} page(s)`);
    } catch (err) {
      showToastMsg(err.message);
    } finally {
      setUploading(false);
      if (addFileRef.current) addFileRef.current.value = '';
    }
  }

  async function handleDeletePage(imageIndex) {
    const allImages = getAllImages();
    const img = allImages[imageIndex];
    if (!img) return;

    try {
      if (img.isPrimary) {
        if (allImages.length <= 1) { showToastMsg("Can't delete the only page"); return; }
        await deletePrimaryImage(id);
      } else {
        await deleteAttachment(id, img.id);
      }
      const fresh = await getDocument(id);
      setDoc(fresh);
      populateEdit(fresh);
      setActiveImage(0);
      setConfirmDeletePage(null);
      showToastMsg('Page deleted');
    } catch (err) {
      showToastMsg(err.message);
    }
  }

  async function handleEditImageSave(blob) {
    const allImages = getAllImages();
    const img = allImages[activeImage];
    if (!img) return;

    try {
      if (img.isPrimary) {
        await replacePrimaryImage(id, blob);
      } else {
        await replaceAttachment(id, img.id, blob);
      }
      const fresh = await getDocument(id);
      setDoc(fresh);
      populateEdit(fresh);
      setEditingImage(false);
      showToastMsg('Image updated');
    } catch (err) {
      showToastMsg(err.message);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const tagList = editTags.split(',').map(t => t.trim()).filter(Boolean);
      await updateDocument(id, {
        title: editTitle, owner_ids: editOwnerIds, type_id: editTypeId,
        document_date: editDocDate || null, expiration_date: editExpDate || null,
        amount: editAmount ? parseFloat(editAmount) : null, vendor: editVendor || null,
        notes: editNotes || null, status: editStatus, tags: tagList
      });
      const fresh = await getDocument(id);
      setDoc(fresh); populateEdit(fresh); setEditing(false); showToastMsg('Saved!');
    } catch (err) { showToastMsg(err.message); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    try { await deleteDocument(id); navigate('/'); }
    catch (err) { showToastMsg(err.message); }
  }

  function showToastMsg(msg) { setToast(msg); setTimeout(() => setToast(''), 2500); }
  function formatDate(dateStr) { if (!dateStr) return '—'; return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

  if (loading) return <div className="spinner" />;
  if (!doc) return null;

  const allImages = getAllImages();
  const currentImg = allImages[activeImage] || allImages[0];
  const isImage = currentImg?.mime_type?.startsWith('image/');

  // Positive-balance types: money coming IN (show green with + prefix)
  const isPositiveType = ['Check', 'Refund', 'Paystub'].includes(doc.type_name);

  return (
    <>
      <button className="btn btn-ghost" onClick={() => navigate(-1)} style={{ marginBottom: '12px' }}>← Back</button>

      {/* Image gallery */}
      <div className="doc-gallery">
        <div className="gallery-main">
          {isImage ? (
            <img src={`/files/${currentImg.file_path}`} alt={doc.title}
              style={{ width: '100%', maxHeight: '500px', objectFit: 'contain', background: '#000', borderRadius: 'var(--radius-md)' }} />
          ) : (
            <div style={{ height: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', borderRadius: 'var(--radius-md)' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '3rem' }}>📄</div>
                <a href={`/files/${currentImg.file_path}`} target="_blank" rel="noopener" className="btn btn-secondary" style={{ marginTop: '12px' }}>Open PDF</a>
              </div>
            </div>
          )}
        </div>

        {/* Thumbnail strip */}
        {allImages.length > 1 && (
          <div className="gallery-strip">
            {allImages.map((img, i) => (
              <div key={img.id || 'primary'} className={`gallery-thumb ${i === activeImage ? 'active' : ''}`}
                onClick={() => setActiveImage(i)}>
                {img.thumbnail_path ? (
                  <img src={`/thumbnails/${img.thumbnail_path}`} alt={`Page ${i + 1}`} />
                ) : (
                  <span style={{ fontSize: '1.2rem' }}>📄</span>
                )}
                <div className="gallery-thumb-label">
                  {i === 0 ? 'Main' : `#${i + 1}`}
                </div>
              </div>
            ))}
            {/* Add more pages button */}
            <div className="gallery-thumb add-page" onClick={() => addFileRef.current?.click()}>
              <span style={{ fontSize: '1.4rem' }}>+</span>
              <div className="gallery-thumb-label">Add</div>
            </div>
            <input ref={addFileRef} type="file" accept="image/*,application/pdf" multiple
              style={{ display: 'none' }} onChange={handleAddPages} />
          </div>
        )}

        {/* Page actions: crop/rotate + delete */}
        <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {allImages.length === 1 && (
            <>
              <button className="btn btn-secondary" onClick={() => addFileRef.current?.click()}>
                {uploading ? 'Uploading...' : '+ Add More Pages'}
              </button>
              <input ref={addFileRef} type="file" accept="image/*,application/pdf" multiple
                style={{ display: 'none' }} onChange={handleAddPages} />
            </>
          )}
          {isImage && (
            <button className="btn btn-ghost" style={{ padding: '4px 12px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}
              onClick={() => setEditingImage(true)}>
              ✂️ Crop / Rotate
            </button>
          )}
          {confirmDeletePage === activeImage ? (
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>Delete this page?</span>
              <button className="btn btn-danger" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                onClick={() => handleDeletePage(activeImage)}>Yes</button>
              <button className="btn btn-ghost" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                onClick={() => setConfirmDeletePage(null)}>No</button>
            </div>
          ) : (
            <button className="btn btn-ghost" style={{ padding: '4px 12px', fontSize: '0.8rem', color: 'var(--text-dim)' }}
              onClick={() => setConfirmDeletePage(activeImage)}>
              🗑️ Delete {allImages.length > 1 ? (activeImage === 0 ? 'main page' : `page #${activeImage + 1}`) : 'page'}
            </button>
          )}
        </div>

        <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginTop: '6px' }}>
          {allImages.length} page{allImages.length !== 1 ? 's' : ''} total
        </div>
      </div>

      {/* Info or edit */}
      {!editing ? (
        <div className="card doc-detail-card" style={{ marginTop: '16px' }}>
          {/* Edit/Delete buttons: rendered first so CSS order can move them to top on mobile */}
          <div className="doc-actions" style={{ display: 'flex', gap: '8px', marginTop: '16px' }}>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setEditing(true)}>✏️ Edit</button>
            {!confirmDelete
              ? <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => setConfirmDelete(true)}>🗑️ Delete</button>
              : <button className="btn btn-danger" style={{ flex: 1 }} onClick={handleDelete}>Confirm Delete?</button>
            }
          </div>

          <div className="doc-info-rows">
            <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '12px' }}>{doc.title}</h2>
            <InfoRow label="Owner">
              <span style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                {doc.owners && doc.owners.length > 0 ? doc.owners.map(o => (
                  <span key={o.id} className="owner-badge" style={{ background: `${o.color}20`, color: o.color }}>
                    {o.icon} {o.name}
                  </span>
                )) : (
                  <span className="owner-badge" style={{ background: `${doc.owner_color}20`, color: doc.owner_color }}>
                    {doc.owner_icon} {doc.owner_name}
                  </span>
                )}
              </span>
            </InfoRow>
            <InfoRow label="Type">{doc.type_icon} {doc.type_name}</InfoRow>
            <InfoRow label="Status"><span className={`status-badge status-${doc.status}`}>{doc.status}</span></InfoRow>
            <InfoRow label="Uploaded">{formatDate(doc.submitted_at)} by {doc.uploaded_by_name}</InfoRow>
            <InfoRow label="Document Date">{formatDate(doc.document_date)}</InfoRow>
            {doc.expiration_date && <InfoRow label="Expires">{formatDate(doc.expiration_date)}</InfoRow>}
            {doc.amount != null && (
              <InfoRow label="Amount">
                <span style={isPositiveType ? { color: 'var(--accent-green)', fontWeight: 600 } : {}}>
                  {isPositiveType ? '+' : ''}${Number(doc.amount).toFixed(2)}
                </span>
              </InfoRow>
            )}
            {doc.vendor && <InfoRow label="Vendor">{doc.vendor}</InfoRow>}
            {doc.notes && <InfoRow label="Notes">{doc.notes}</InfoRow>}
            {doc.tags && doc.tags.length > 0 && (
              <InfoRow label="Tags">
                {doc.tags.map(t => (
                  <span key={t} style={{ background: 'var(--bg-input)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', marginRight: '4px' }}>{t}</span>
                ))}
              </InfoRow>
            )}

            {doc.ocr_text ? (
              <div style={{ marginTop: '12px' }}>
                <button className="btn btn-ghost" onClick={() => setShowOcr(!showOcr)} style={{ fontSize: '0.8rem', padding: '4px 8px' }}>
                  {showOcr ? '▼' : '▶'} OCR Text ({doc.ocr_status})
                </button>
                {showOcr && (
                  <pre style={{ background: 'var(--bg-input)', padding: '12px', borderRadius: 'var(--radius-sm)', marginTop: '8px',
                    fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '300px', overflowY: 'auto' }}>
                    {doc.ocr_text}
                  </pre>
                )}
              </div>
            ) : (
              <div style={{ marginTop: '12px' }}>
                <button className="btn btn-ghost" style={{ fontSize: '0.8rem', padding: '4px 8px' }}
                  onClick={async () => {
                    showToastMsg('Running OCR...');
                    try {
                      await ocrRescan(id);
                      const fresh = await getDocument(id);
                      setDoc(fresh);
                      showToastMsg(fresh.ocr_text ? 'OCR complete!' : 'No text detected');
                    } catch (err) { showToastMsg(err.message); }
                  }}>
                  🔍 Run OCR Scan
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="card" style={{ marginTop: '16px' }}>
          <h3 style={{ marginBottom: '16px' }}>Edit Document</h3>
          <div className="form-group"><label>Title</label><input type="text" value={editTitle} onChange={e => setEditTitle(e.target.value)} /></div>
          <div className="form-group">
            <label>Owner(s) <span style={{ fontWeight: 400, textTransform: 'none', fontSize: '0.75rem' }}>(select all that apply)</span></label>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {owners.map(o => (
                <button key={o.id} type="button"
                  className={`chip ${editOwnerIds.includes(o.id) ? 'active' : ''}`}
                  onClick={() => setEditOwnerIds(prev => prev.includes(o.id) ? prev.filter(x => x !== o.id) : [...prev, o.id])}
                  style={editOwnerIds.includes(o.id) ? {} : { borderColor: o.color, color: o.color }}>
                  {o.icon} {o.name}
                </button>
              ))}
            </div>
          </div>
          <div className="form-group"><label>Type</label><select value={editTypeId} onChange={e => setEditTypeId(e.target.value)}>{types.map(t => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}</select></div>
          <div className="form-group"><label>Status</label><select value={editStatus} onChange={e => setEditStatus(e.target.value)}><option value="active">Active</option><option value="expired">Expired</option><option value="archived">Archived</option></select></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group"><label>Document Date</label><input type="date" value={editDocDate} onChange={e => setEditDocDate(e.target.value)} /></div>
            <div className="form-group"><label>Expiration</label><input type="date" value={editExpDate} onChange={e => setEditExpDate(e.target.value)} /></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group"><label>Amount ($)</label><input type="number" step="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)} /></div>
            <div className="form-group"><label>Vendor</label><input type="text" value={editVendor} onChange={e => setEditVendor(e.target.value)} /></div>
          </div>
          <div className="form-group"><label>Tags</label><TagInput value={editTags} onChange={setEditTags} /></div>
          <div className="form-group"><label>Notes</label><textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} rows={3} /></div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : '💾 Save'}</button>
            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => { setEditing(false); populateEdit(doc); }}>Cancel</button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}

      {editingImage && isImage && (
        <ImageEditor
          imageSrc={`/files/${currentImg.file_path}`}
          onSave={handleEditImageSave}
          onCancel={() => setEditingImage(false)}
        />
      )}
    </>
  );
}

function InfoRow({ label, children }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: '0.88rem' }}>
      <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>{label}</span>
      <span>{children}</span>
    </div>
  );
}
