import { useEffect, useRef, useState, type ReactNode } from 'react';

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
  precision?: number;
}

/** Campo numérico; arrastrar la etiqueta horizontalmente cambia el valor (como en After Effects / Figma). */
export function NumberField({ label, value, onChange, step = 1, min = -Infinity, max = Infinity, suffix, precision = 2 }: NumberFieldProps) {
  const round = (v: number) => Number(v.toFixed(precision));
  const [text, setText] = useState(String(round(value)));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(round(value)));
  }, [value, focused]);

  const commit = (v: number) => {
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
  };

  const onScrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = value;
    const move = (ev: PointerEvent) => {
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      commit(round(v0 + Math.round((ev.clientX - x0) / 2) * step * mult));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <label className="field">
      <span className="field-label scrub" onPointerDown={onScrub}>
        {label}
      </span>
      <div className="num-wrap">
        <input
          className="input"
          type="number"
          step={step}
          value={text}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value !== '' && e.target.value !== '-') commit(parseFloat(e.target.value));
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {suffix && <span className="suffix">{suffix}</span>}
      </div>
    </label>
  );
}

/** Deslizador propio (el input range nativo se ve distinto en cada navegador y desentona con el tema). */
export function Range({ min, max, step = 0.01, value, onChange, label }: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  const snap = (v: number) => {
    const s = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(s.toFixed(6))));
  };
  const fromPointer = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    onChange(snap(min + ((clientX - r.left) / r.width) * (max - min)));
  };
  return (
    <div
      ref={ref}
      className={`range ${dragging ? 'dragging' : ''}`}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      style={{ '--pct': `${pct}%` } as React.CSSProperties}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragging(true);
        fromPointer(e.clientX);
      }}
      onPointerMove={(e) => dragging && fromPointer(e.clientX)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onKeyDown={(e) => {
        const big = (max - min) / 10;
        const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -big, PageUp: big }[e.key];
        if (d !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          onChange(snap(value + d * (e.shiftKey ? 10 : 1)));
        } else if (e.key === 'Home') onChange(min);
        else if (e.key === 'End') onChange(max);
      }}
    >
      <div className="range-track">
        <div className="range-fill" />
      </div>
      <div className="range-thumb" />
    </div>
  );
}

export function SliderField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { label, value, min, max, step = 0.01, format = (v) => v.toFixed(2), onChange } = props;
  return (
    <div className="slider-field">
      <span className="field-label">{label}</span>
      <Range min={min} max={max} step={step} value={value} onChange={onChange} />
      <span className="val">{format(value)}</span>
    </div>
  );
}

export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="color-field">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value);
          }}
        />
      </div>
    </label>
  );
}

export function SelectField<T extends string | number>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      <select
        className="select"
        value={props.value}
        onChange={(e) => {
          const raw = e.target.value;
          props.onChange((typeof props.value === 'number' ? Number(raw) : raw) as T);
        }}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Segmented<T extends string>(props: {
  value: T;
  options: { value: T; icon: ReactNode; title: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {props.options.map((o) => (
        <button key={o.value} title={o.title} className={props.value === o.value ? 'on' : ''} onClick={() => props.onChange(o.value)}>
          {o.icon}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onClick, title, children }: { on: boolean; onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button className={`btn sm icon ${on ? 'active' : ''}`} title={title} onClick={onClick}>
      {children}
    </button>
  );
}

export function Section({ title, children, extra }: { title: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">
        {title}
        {extra}
      </div>
      {children}
    </div>
  );
}
