import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Template } from '@sim/engine';
import { TEMPLATE_CATEGORIES, groupTemplates } from '@sim/templates';

/** Every word of the query appears in the template's name, id, description or section. */
const matches = (t: Template, words: string[]): boolean => {
  const label = TEMPLATE_CATEGORIES.find((c) => c.id === t.category)?.label ?? '';
  const haystack = `${t.name} ${t.id} ${t.description} ${label}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
};

/** Template dropdown with sections and type-to-filter. */
export function TemplatePicker({ templates, value, onChange }: { templates: Template[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = templates.find((t) => t.id === value);

  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return groupTemplates(templates.filter((t) => matches(t, words)));
  }, [templates, query]);
  const flat = groups.flatMap((g) => g.templates);

  // Typing jumps to the first match.
  useEffect(() => {
    if (query) setActive(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // Opens on the current template (the query is empty while closed, so `flat` is every template).
  const openPicker = () => {
    setActive(Math.max(0, flat.findIndex((t) => t.id === value)));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setQuery('');
    triggerRef.current?.focus();
  };
  const choose = (id: string) => {
    if (id !== value) onChange(id);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flat[active]) choose(flat[active].id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      setOpen(false);
      setQuery('');
    }
  };

  let index = -1;
  return (
    <div className="template-picker" ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="template-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openPicker())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openPicker();
          }
        }}
      >
        <span>{current?.name ?? value}</span>
        <span className="template-trigger-meta">{TEMPLATE_CATEGORIES.find((c) => c.id === current?.category)?.label} ▾</span>
      </button>
      {open && (
        <div className="template-pop">
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={flat[active] ? `${listId}-${flat[active].id}` : undefined}
            placeholder={`Search ${templates.length} templates…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="template-list" role="listbox" id={listId} ref={listRef}>
            {groups.map((g) => (
              <div key={g.id} role="group" aria-label={g.label}>
                <div className="template-group">{g.label}</div>
                {g.templates.map((t) => {
                  const i = ++index;
                  return (
                    <div
                      key={t.id}
                      id={`${listId}-${t.id}`}
                      role="option"
                      aria-selected={t.id === value}
                      data-active={i === active}
                      className={`template-option${i === active ? ' active' : ''}${t.id === value ? ' current' : ''}`}
                      onPointerMove={() => setActive(i)}
                      onClick={() => choose(t.id)}
                    >
                      {t.name}
                    </div>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && <p className="hint template-empty">No templates match “{query}”.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
