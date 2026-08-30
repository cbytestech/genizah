import { useState, useEffect, useRef } from 'react';
import { getTags } from '../services/api';

export default function TagInput({ value, onChange }) {
  const [allTags, setAllTags] = useState([]);
  const [inputVal, setInputVal] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const inputRef = useRef(null);
  const wrapperRef = useRef(null);

  // Parse value string into array of tag names
  const selectedTags = value ? value.split(',').map(t => t.trim()).filter(Boolean) : [];

  useEffect(() => {
    getTags().then(tags => setAllTags(tags.map(t => t.name || t))).catch(() => {});
  }, []);

  // Close suggestions when clicking outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function updateParent(newTags) {
    onChange(newTags.join(', '));
  }

  function addTag(tagName) {
    const trimmed = tagName.trim().toLowerCase();
    if (!trimmed) return;
    if (!selectedTags.includes(trimmed)) {
      updateParent([...selectedTags, trimmed]);
    }
    setInputVal('');
    setSuggestions([]);
    setShowSuggestions(false);
    setActiveSuggestion(-1);
    inputRef.current?.focus();
  }

  // Add multiple tags at once (from comma-split input)
  function addMultipleTags(names, currentTags) {
    let updated = [...currentTags];
    for (const raw of names) {
      const trimmed = raw.trim().toLowerCase();
      if (trimmed && !updated.includes(trimmed)) {
        updated.push(trimmed);
      }
    }
    return updated;
  }

  function removeTag(tagName) {
    updateParent(selectedTags.filter(t => t !== tagName));
  }

  function handleInputChange(e) {
    const val = e.target.value;

    // Mobile keyboards insert the comma character directly into the value
    // instead of firing a keyDown event, so we split on commas here
    if (val.includes(',')) {
      const parts = val.split(',');
      // Everything except the last segment becomes a tag immediately
      const tagsToAdd = parts.slice(0, -1);
      const remainder = parts[parts.length - 1];

      if (tagsToAdd.length > 0) {
        const updated = addMultipleTags(tagsToAdd, selectedTags);
        updateParent(updated);
      }

      // Keep whatever is after the last comma as the ongoing input
      setInputVal(remainder);
      updateSuggestions(remainder);
      return;
    }

    setInputVal(val);
    updateSuggestions(val);
  }

  function updateSuggestions(val) {
    if (val.trim()) {
      const filtered = allTags.filter(t =>
        t.toLowerCase().includes(val.toLowerCase()) &&
        !selectedTags.includes(t.toLowerCase())
      );
      setSuggestions(filtered.slice(0, 6));
      setShowSuggestions(filtered.length > 0);
      setActiveSuggestion(-1);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (activeSuggestion >= 0 && suggestions[activeSuggestion]) {
        addTag(suggestions[activeSuggestion]);
      } else if (inputVal.trim()) {
        addTag(inputVal);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveSuggestion(prev => Math.min(prev + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveSuggestion(prev => Math.max(prev - 1, -1));
    } else if (e.key === 'Backspace' && !inputVal && selectedTags.length > 0) {
      removeTag(selectedTags[selectedTags.length - 1]);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  }

  // When the input loses focus, commit any remaining text as a tag
  function handleBlur() {
    if (inputVal.trim()) {
      // Small delay so suggestion clicks can fire first
      setTimeout(() => {
        if (inputVal.trim()) {
          addTag(inputVal);
        }
      }, 150);
    }
    // Hide suggestions after a short delay (let click events fire)
    setTimeout(() => setShowSuggestions(false), 200);
  }

  return (
    <div ref={wrapperRef} style={{ position: 'relative' }}>
      <div className="tag-input-wrapper" onClick={() => inputRef.current?.focus()}>
        {selectedTags.map(tag => (
          <span key={tag} className="tag-chip">
            {tag}
            <button type="button" onClick={e => { e.stopPropagation(); removeTag(tag); }}
              className="tag-chip-remove">&times;</button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={inputVal}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onFocus={() => { if (inputVal.trim() && suggestions.length) setShowSuggestions(true); }}
          placeholder={selectedTags.length === 0 ? 'Type to add tags...' : ''}
          className="tag-input-field"
          enterKeyHint="done"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </div>
      {showSuggestions && (
        <div className="tag-suggestions">
          {suggestions.map((s, i) => (
            <div key={s}
              className={`tag-suggestion-item ${i === activeSuggestion ? 'active' : ''}`}
              onMouseDown={e => { e.preventDefault(); addTag(s); }}>
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
