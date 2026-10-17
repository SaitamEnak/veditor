import { useRef, useState } from 'react';
import type { MediaClip } from '../../shared/types';
import { MAX_GAIN, envelopeAt } from '../../shared/types';
import { clamp } from '../lib/util';
import { useEditor } from '../store';

const PAD = 5;

/**
 * Curva de volumen editable sobre un clip con sonido.
 * Clic en la línea: añade un nodo (y lo puedes arrastrar sin soltar).
 * Arrastrar un nodo: vertical = volumen (0–200%, se imanta al 100%; Alt desactiva), horizontal = tiempo.
 * Doble clic o clic derecho en un nodo: lo elimina.
 */
export function VolumeEnvelope({ clip, zoom, height, locked }: { clip: MediaClip; zoom: number; height: number; locked: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const w = Math.max(2, clip.duration * zoom);
  const ih = height - PAD * 2;
  const end = clip.in + clip.duration;
  const keys = clip.volumeKeys ?? [];

  const yOf = (v: number) => PAD + (1 - v / MAX_GAIN) * ih;
  const vOf = (y: number) => clamp((1 - (y - PAD) / ih) * MAX_GAIN, 0, MAX_GAIN);
  const xOf = (t: number) => (t - clip.in) * zoom;
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const visible = keys.map((k, i) => ({ k, i })).filter(({ k }) => k.t >= clip.in - 1e-6 && k.t <= end + 1e-6);
  const pts: [number, number][] = [
    [0, yOf(envelopeAt(keys, clip.in))],
    ...visible.map(({ k }) => [xOf(k.t), yOf(k.v)] as [number, number]),
    [w, yOf(envelopeAt(keys, end))],
  ];
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

  const dragKey = (e: React.PointerEvent, index: number, fresh = false) => {
    e.stopPropagation();
    e.preventDefault();
    if (locked) return;
    const st = useEditor.getState();
    st.select(clip.id);
    if (!fresh) st.checkpoint();
    const rect = svgRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const x = ev.clientX - rect.left;
      let v = vOf(ev.clientY - rect.top);
      if (!ev.altKey && Math.abs(v - 1) < 0.06) v = 1;
      v = Math.round(v * 1000) / 1000;
      let t = 0;
      st.updateClip(clip.id, (c) => {
        const mc = c as MediaClip;
        const ks = mc.volumeKeys;
        if (!ks?.[index]) return;
        const lo = Math.max(mc.in, index > 0 ? ks[index - 1].t + 0.01 : -Infinity);
        const hi = Math.min(mc.in + mc.duration, index < ks.length - 1 ? ks[index + 1].t - 0.01 : Infinity);
        t = clamp(mc.in + x / zoom, lo, hi);
        ks[index] = { t, v };
      }, false);
      setTip({ x: xOf(t), y: yOf(v), text: pct(v) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setTip(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addKey = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (locked) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const t = clip.in + (e.clientX - rect.left) / zoom;
    const v = Math.round(envelopeAt(keys, t) * 1000) / 1000;
    let index = 0;
    const st = useEditor.getState();
    st.select(clip.id);
    st.updateClip(clip.id, (c) => {
      const ks = ((c as MediaClip).volumeKeys ??= []);
      index = ks.findIndex((k) => k.t > t);
      if (index < 0) index = ks.length;
      ks.splice(index, 0, { t, v });
    });
    dragKey(e, index, true);
  };

  const removeKey = (index: number) => {
    if (locked) return;
    useEditor.getState().updateClip(clip.id, (c) => {
      const mc = c as MediaClip;
      mc.volumeKeys?.splice(index, 1);
      if (!mc.volumeKeys?.length) delete mc.volumeKeys;
    });
  };

  return (
    <>
      <svg ref={svgRef} className="env" width={w} height={height}>
        {keys.length > 0 && <line className="env-ref" x1={0} x2={w} y1={yOf(1)} y2={yOf(1)} />}
        <polygon className="env-fill" points={`0,${height} ${line} ${w},${height}`} />
        <polyline className="env-line" points={line} />
        <polyline className="env-hit" points={line} onPointerDown={addKey}>
          <title>Clic para añadir un nodo de volumen</title>
        </polyline>
        {visible.map(({ k, i }) => (
          <circle
            key={i}
            className="env-node"
            cx={xOf(k.t)}
            cy={yOf(k.v)}
            r={4}
            onPointerDown={(e) => dragKey(e, i)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              removeKey(i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              removeKey(i);
            }}
          >
            <title>{`${pct(k.v)} · doble clic para borrar`}</title>
          </circle>
        ))}
      </svg>
      {tip && (
        <div className="env-tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </>
  );
}
