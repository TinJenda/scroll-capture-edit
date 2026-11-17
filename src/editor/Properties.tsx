import { AlignCenter, AlignLeft, AlignRight, ArrowDownToLine, ArrowUpToLine, Bold, Copy, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { BUILTIN_PRESETS, type AnnotationPreset } from '@/shared/settings';
import type { AnnotationType } from './model';
import { propsOfAnnotation, propsOfStyle, kindForTool, type PanelProps } from './props';
import { TOOL_LABEL } from './shortcuts';
import { selectSelected, useEditor } from './store';

const PALETTE = ['#FF3B30', '#FF9500', '#FFD60A', '#34C759', '#0A84FF', '#AF52DE', '#111111', '#FFFFFF'];

const KIND_LABEL: Record<AnnotationType, string> = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  arrow: 'Arrow',
  line: 'Line',
  pen: 'Pen',
  highlighter: 'Highlighter',
  text: 'Text',
  marker: 'Numbered marker',
  blur: 'Blur',
  pixelate: 'Pixelate',
};

interface Props {
  userPresets: AnnotationPreset[];
  onApplyPreset(p: AnnotationPreset): void;
  onSavePreset(name: string): void;
  onDeletePreset(id: string): void;
  autoRenumber: boolean;
  onAutoRenumber(v: boolean): void;
}

function Swatches({ value, onChange, label }: { value: string; onChange(c: string): void; label: string }) {
  return (
    <div className="swatches" role="group" aria-label={label}>
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch${value.toLowerCase() === c.toLowerCase() ? ' on' : ''}`}
          style={{ background: c }}
          aria-label={`${label} ${c}`}
          aria-pressed={value.toLowerCase() === c.toLowerCase()}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="swatch custom" title="Custom colour">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#ff3b30'} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={`${label} custom`} />
      </label>
    </div>
  );
}

function Range({ label, value, min, max, step = 1, onChange, suffix = '' }: { label: string; value: number; min: number; max: number; step?: number; onChange(v: number): void; suffix?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <div className="range">
        <input type="range" min={min} max={max} step={step} value={Math.min(max, Math.max(min, value))} onChange={(e) => onChange(Number(e.target.value))} />
        <output>
          {Math.round(value * 100) / 100}
          {suffix}
        </output>
      </div>
    </label>
  );
}

export function Properties({ userPresets, onApplyPreset, onSavePreset, onDeletePreset, autoRenumber, onAutoRenumber }: Props) {
  const tool = useEditor((s) => s.tool);
  const selected = useEditor(selectSelected);
  const style = useEditor((s) => s.style);
  const markers = useEditor((s) => s.history.present.annotations.filter((a) => a.type === 'marker').length);
  const [presetName, setPresetName] = useState('');

  const kind: AnnotationType | null = selected?.type ?? kindForTool(tool);
  if (!kind) return null;

  const p: PanelProps = selected ? propsOfAnnotation(selected) : propsOfStyle(kind, style);
  const set = (patch: PanelProps) => useEditor.getState().setProps(patch);
  const st = useEditor.getState;

  const showColor = kind !== 'blur' && kind !== 'pixelate';
  const showWidth = ['rect', 'ellipse', 'line', 'arrow', 'pen', 'highlighter'].includes(kind);
  const allPresets = [...BUILTIN_PRESETS, ...userPresets];

  return (
    <aside className="props" aria-label="Properties" data-testid="properties">
      <h2>
        {selected ? KIND_LABEL[kind] : `${TOOL_LABEL[tool] ?? KIND_LABEL[kind]} defaults`}
        {selected && <span className="muted"> · selected</span>}
      </h2>

      {showColor && (
        <div className="field">
          <span>{kind === 'marker' ? 'Background' : kind === 'text' ? 'Text colour' : 'Colour'}</span>
          <Swatches value={p.color ?? '#FF3B30'} onChange={(color) => set({ color })} label="Colour" />
        </div>
      )}

      {kind === 'marker' && (
        <>
          <div className="field">
            <span>Number colour</span>
            <Swatches value={p.textColor ?? '#FFFFFF'} onChange={(textColor) => set({ textColor })} label="Number colour" />
          </div>
          <Range label="Size" value={p.radius ?? 14} min={8} max={80} onChange={(radius) => set({ radius })} suffix="px" />
          {selected && (
            <label className="field">
              <span>Number</span>
              <input
                className="num"
                type="number"
                min={0}
                max={9999}
                value={p.number ?? 1}
                onChange={(e) => set({ number: Number(e.target.value) })}
                aria-label="Marker number"
              />
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={autoRenumber} onChange={(e) => onAutoRenumber(e.target.checked)} />
            <span>Renumber automatically when one is deleted</span>
          </label>
          <button type="button" className="btn btn-sm" disabled={markers < 2} onClick={() => st().renumber()}>
            Renumber 1…{markers} in order
          </button>
        </>
      )}

      {showWidth && <Range label={kind === 'highlighter' ? 'Thickness' : 'Line width'} value={p.width ?? 3} min={1} max={kind === 'highlighter' ? 60 : 30} onChange={(width) => set({ width })} suffix="px" />}

      {kind === 'highlighter' && <Range label="Opacity" value={p.opacity ?? 0.4} min={0.1} max={1} step={0.05} onChange={(opacity) => set({ opacity })} />}

      {(kind === 'rect' || kind === 'ellipse') && (
        <div className="field">
          <span>Fill</span>
          <div className="row">
            <button type="button" className={`btn btn-sm${p.fill ? '' : ' active'}`} aria-pressed={!p.fill} onClick={() => set({ fill: null })}>
              None
            </button>
            <button type="button" className={`btn btn-sm${p.fill ? ' active' : ''}`} aria-pressed={!!p.fill} onClick={() => set({ fill: p.fill ?? '#FFD60A' })}>
              Solid
            </button>
            {p.fill && <input type="color" className="mini-color" value={p.fill.slice(0, 7)} onChange={(e) => set({ fill: e.target.value.toUpperCase() })} aria-label="Fill colour" />}
          </div>
        </div>
      )}

      {kind === 'text' && (
        <>
          <Range label="Font size" value={p.fontSize ?? 24} min={8} max={160} onChange={(fontSize) => set({ fontSize })} suffix="px" />
          <div className="field">
            <span>Style</span>
            <div className="row">
              {(['left', 'center', 'right'] as const).map((a) => {
                const Icon = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
                return (
                  <button key={a} type="button" className={`icon-btn${p.align === a ? ' active' : ''}`} aria-label={`Align ${a}`} aria-pressed={p.align === a} onClick={() => set({ align: a })}>
                    <Icon size={16} />
                  </button>
                );
              })}
              <button type="button" className={`icon-btn${p.bold ? ' active' : ''}`} aria-label="Bold" aria-pressed={!!p.bold} onClick={() => set({ bold: !p.bold })}>
                <Bold size={16} />
              </button>
            </div>
          </div>
        </>
      )}

      {(kind === 'blur' || kind === 'pixelate') && (
        <Range label={kind === 'blur' ? 'Blur strength' : 'Block size'} value={p.strength ?? 10} min={2} max={60} onChange={(strength) => set({ strength })} suffix="px" />
      )}

      {selected && (
        <div className="field">
          <span>Arrange</span>
          <div className="row">
            <button type="button" className="icon-btn" title="Duplicate (Ctrl+D)" aria-label="Duplicate" onClick={() => st().duplicateSelected()}>
              <Copy size={16} />
            </button>
            <button type="button" className="icon-btn" title="Bring to front" aria-label="Bring to front" onClick={() => st().bringToFront()}>
              <ArrowUpToLine size={16} />
            </button>
            <button type="button" className="icon-btn" title="Send to back" aria-label="Send to back" onClick={() => st().sendToBack()}>
              <ArrowDownToLine size={16} />
            </button>
            <button type="button" className="icon-btn btn-danger" title="Delete (Del)" aria-label="Delete annotation" onClick={() => st().deleteSelected()}>
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="presets">
        <h3>Presets</h3>
        <div className="chips">
          {allPresets.map((preset) => (
            <span key={preset.id} className="chip">
              <button type="button" onClick={() => onApplyPreset(preset)} title={`Use "${preset.name}"`}>
                <i style={{ background: preset.color }} />
                {preset.name}
              </button>
              {!preset.builtin && (
                <button type="button" className="x" aria-label={`Delete preset ${preset.name}`} onClick={() => onDeletePreset(preset.id)}>
                  <X size={12} />
                </button>
              )}
            </span>
          ))}
        </div>
        {kind !== 'blur' && kind !== 'pixelate' && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (presetName.trim()) {
                onSavePreset(presetName.trim());
                setPresetName('');
              }
            }}
          >
            <input className="txt" placeholder="Save current style as…" value={presetName} maxLength={40} onChange={(e) => setPresetName(e.target.value)} aria-label="Preset name" />
            <button type="submit" className="btn btn-sm" disabled={!presetName.trim()}>
              Save
            </button>
          </form>
        )}
      </div>
    </aside>
  );
}
