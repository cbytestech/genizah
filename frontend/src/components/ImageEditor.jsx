import { useState, useRef } from 'react';
import Cropper from 'react-cropper';
import 'cropperjs/dist/cropper.css';

export default function ImageEditor({ imageSrc, onSave, onCancel }) {
  const cropperRef = useRef(null);
  const [saving, setSaving] = useState(false);

  function getCropper() {
    return cropperRef.current?.cropper;
  }

  function rotateLeft() {
    getCropper()?.rotate(-90);
  }

  function rotateRight() {
    getCropper()?.rotate(90);
  }

  function resetCrop() {
    getCropper()?.reset();
  }

  async function handleSave() {
    const cropper = getCropper();
    if (!cropper) return;
    setSaving(true);

    try {
      const canvas = cropper.getCroppedCanvas({
        maxWidth: 4096,
        maxHeight: 4096,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'high',
      });

      canvas.toBlob((blob) => {
        onSave(blob);
        setSaving(false);
      }, 'image/jpeg', 0.92);
    } catch (err) {
      console.error('Crop failed:', err);
      setSaving(false);
    }
  }

  return (
    <div className="image-editor-overlay">
      <div className="image-editor-container">
        <div className="image-editor-crop-area">
          <Cropper
            ref={cropperRef}
            src={imageSrc}
            style={{ height: '100%', width: '100%' }}
            guides={true}
            viewMode={1}
            dragMode="move"
            autoCropArea={0.85}
            responsive={true}
            restore={false}
            checkOrientation={true}
            background={false}
            modal={true}
            highlight={true}
            cropBoxMovable={true}
            cropBoxResizable={true}
            toggleDragModeOnDblclick={false}
          />
        </div>

        <div className="image-editor-controls">
          <div className="image-editor-row">
            <button type="button" className="btn btn-secondary" onClick={rotateLeft}>
              ↶ 90°
            </button>
            <button type="button" className="btn btn-secondary" onClick={rotateRight}>
              ↷ 90°
            </button>
            <button type="button" className="btn btn-ghost" onClick={resetCrop}>
              Reset
            </button>
          </div>

          <div className="image-editor-row" style={{ marginTop: '6px' }}>
            <button type="button" className="btn btn-ghost" onClick={onCancel} style={{ flex: 1 }}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving} style={{ flex: 1 }}>
              {saving ? 'Processing...' : '✓ Apply'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
