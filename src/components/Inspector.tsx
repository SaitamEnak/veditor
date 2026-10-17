import {
  AlignCenter, AlignLeft, AlignRight, Bold, CaseUpper, Copy, Crosshair, Film, Image as ImageIcon, Italic, Maximize,
  Music, Scissors, Spline, Subtitles, Trash2, Type, Unlink, X,
} from 'lucide-react';
import type { Clip, MediaClip, Project, TextClip, TextStyle, Transform } from '../../shared/types';
import { clipEnd, envelopeAt, isMediaClip, isTextClip, projectDuration } from '../../shared/types';
import { findClip } from '../lib/ops';
import { FONTS } from '../lib/render';
import { formatTime } from '../lib/util';
import { useEditor } from '../store';
import { ColorField, NumberField, Section, Segmented, SelectField, SliderField, Toggle } from './fields';

export const CLIP_META: Record<Clip['type'], { label: string; color: string; Icon: typeof Film }> = {
  video: { label: 'Video', color: 'var(--clip-video)', Icon: Film },
  image: { label: 'Imagen', color: 'var(--clip-image)', Icon: ImageIcon },
  audio: { label: 'Audio', color: 'var(--clip-audio)', Icon: Music },
  text: { label: 'Texto', color: 'var(--clip-text)', Icon: Type },
  subtitle: { label: 'Subtítulo', color: 'var(--clip-subtitle)', Icon: Subtitles },
};

export function Inspector() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const selectedIds = useEditor((s) => s.selectedIds);
  const checkpoint = useEditor((s) => s.checkpoint);
  const found = findClip(project, selectedId);

  if (selectedIds.length > 1)
    return (
      <aside className="panel panel-right" onPointerDownCapture={checkpoint} onFocusCapture={checkpoint}>
        <MultiInspector ids={selectedIds} project={project} />
      </aside>
    );

  return (
    <aside className="panel panel-right" onPointerDownCapture={checkpoint} onFocusCapture={checkpoint}>
      {found ? <ClipInspector key={found.clip.id} clip={found.clip} project={project} locked={found.track.locked} /> : <ProjectInspector project={project} />}
    </aside>
  );
}

function ClipInspector({ clip, project, locked }: { clip: Clip; project: Project; locked: boolean }) {
  const { updateClip, splitAt, deleteSelected, duplicateSelected, detachAudio } = useEditor.getState();
  const edit = (fn: (c: any) => void) => !locked && updateClip(clip.id, fn, false);
  const meta = CLIP_META[clip.type];
  const asset = isMediaClip(clip) ? project.assets.find((a) => a.id === clip.assetId) : undefined;
  const title = isTextClip(clip) ? clip.text.split('\n')[0] || meta.label : asset?.name ?? 'Medio no encontrado';
  const detached = clip.type === 'video' && !!clip.audioDetached;
  const hasAudio = clip.type === 'audio' || (clip.type === 'video' && asset?.hasAudio && !detached);
  const visual = clip.type !== 'audio';
  const sourceLimited = clip.type === 'video' || clip.type === 'audio';

  return (
    <>
      <div className="insp-head">
        <div className="insp-icon" style={{ background: meta.color }}>
          <meta.Icon size={16} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="insp-title">{title}</div>
          <div className="insp-sub">
            {meta.label} · {formatTime(clip.duration, project.fps)}
            {locked && ' · pista bloqueada'}
          </div>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        <Section title="Tiempo">
          <div className="row three">
            <NumberField label="Inicio" value={clip.start} step={0.05} min={0} suffix="s" onChange={(v) => edit((c) => (c.start = v))} />
            <NumberField
              label="Duración"
              value={clip.duration}
              step={0.05}
              min={0.1}
              max={sourceLimited && asset ? asset.duration - (clip as MediaClip).in : Infinity}
              suffix="s"
              onChange={(v) => edit((c) => (c.duration = v))}
            />
            {sourceLimited && asset ? (
              <NumberField
                label="Entrada"
                value={(clip as MediaClip).in}
                step={0.05}
                min={0}
                max={asset.duration - 0.1}
                suffix="s"
                onChange={(v) =>
                  edit((c: MediaClip) => {
                    c.in = v;
                    c.duration = Math.min(c.duration, asset.duration - v);
                  })
                }
              />
            ) : (
              <span />
            )}
          </div>
          <div className="btn-row">
            <button className="btn sm" title="Dividir en el cabezal (S)" onClick={() => splitAt(useEditor.getState().playhead, clip.id)} disabled={locked}>
              <Scissors size={13} /> Dividir
            </button>
            <button className="btn sm" title="Duplicar (Ctrl+D)" onClick={duplicateSelected}>
              <Copy size={13} /> Duplicar
            </button>
            <button className="btn sm danger" title="Eliminar (Supr)" onClick={deleteSelected} disabled={locked}>
              <Trash2 size={13} /> Eliminar
            </button>
          </div>
        </Section>

        {isTextClip(clip) && <TextSections clip={clip} edit={edit} />}

        {visual && <TransformSection clip={clip as MediaClip | TextClip} project={project} edit={edit} aspect={asset && { w: asset.width, h: asset.height }} />}

        {hasAudio && (
          <Section title="Audio">
            {clip.type === 'video' && (
              <button className="btn sm block" style={{ marginBottom: 10 }} disabled={locked} onClick={() => detachAudio(clip.id)} title="Mueve el sonido a una pista de audio independiente">
                <Unlink size={13} /> Separar audio
              </button>
            )}
            <SliderField
              label="Volumen"
              value={(clip as MediaClip).volume}
              min={0}
              max={2}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => edit((c) => (c.volume = v))}
            />
            <VolumeKeysControls clip={clip as MediaClip} locked={locked} />
          </Section>
        )}

        {detached && (
          <Section title="Audio">
            <div className="insp-sub">El audio de este clip está separado en una pista de audio.</div>
          </Section>
        )}

        <Section title="Fundidos">
          <SliderField label="Entrada" value={clip.fadeIn} min={0} max={Math.min(5, clip.duration / 2)} format={(v) => `${v.toFixed(2)}s`} onChange={(v) => edit((c) => (c.fadeIn = v))} />
          <SliderField label="Salida" value={clip.fadeOut} min={0} max={Math.min(5, clip.duration / 2)} format={(v) => `${v.toFixed(2)}s`} onChange={(v) => edit((c) => (c.fadeOut = v))} />
        </Section>
      </div>
    </>
  );
}

function VolumeKeysControls({ clip, locked }: { clip: MediaClip; locked: boolean }) {
  const { updateClip } = useEditor.getState();
  const n = clip.volumeKeys?.length ?? 0;
  const addAtPlayhead = () => {
    const ph = useEditor.getState().playhead;
    if (ph < clip.start || ph > clipEnd(clip)) return;
    const t = clip.in + (ph - clip.start);
    updateClip(clip.id, (c) => {
      const mc = c as MediaClip;
      const ks = (mc.volumeKeys ??= []);
      const v = Math.round(envelopeAt(ks, t) * 1000) / 1000;
      const i = ks.findIndex((k) => k.t > t);
      ks.splice(i < 0 ? ks.length : i, 0, { t, v });
    });
  };
  return (
    <>
      <div className="field-label" style={{ margin: '4px 0 6px', display: 'flex', justifyContent: 'space-between' }}>
        <span>Nodos de volumen</span>
        <span>{n}</span>
      </div>
      <div className="btn-row">
        <button className="btn sm" disabled={locked} onClick={addAtPlayhead} title="Añade un nodo en la posición del cabezal">
          <Spline size={13} /> Nodo en cabezal
        </button>
        <button
          className="btn sm danger"
          disabled={locked || n === 0}
          onClick={() => updateClip(clip.id, (c) => void delete (c as MediaClip).volumeKeys)}
          title="Elimina todos los nodos de volumen"
        >
          <X size={13} /> Quitar
        </button>
      </div>
      <div className="insp-sub" style={{ marginTop: 8 }}>
        Clic en la línea amarilla del clip para crear nodos. Arrastra para subir o bajar el volumen; doble clic borra un nodo.
      </div>
    </>
  );
}

function MultiInspector({ ids, project }: { ids: string[]; project: Project }) {
  const { update, splitAt, deleteSelected, duplicateSelected, select } = useEditor.getState();
  const clips = ids.map((id) => findClip(project, id)).filter(Boolean) as NonNullable<ReturnType<typeof findClip>>[];
  const start = Math.min(...clips.map((f) => f.clip.start));
  const end = Math.max(...clips.map((f) => clipEnd(f.clip)));
  const sound = clips.filter((f) => f.clip.type === 'audio' || (f.clip.type === 'video' && !(f.clip as MediaClip).audioDetached));
  const editAll = (fn: (c: Clip) => void, filter: (c: Clip) => boolean = () => true) =>
    update((p) => {
      for (const id of ids) {
        const f = findClip(p, id);
        if (f && !f.track.locked && filter(f.clip)) fn(f.clip);
      }
    }, false);
  const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0);

  return (
    <>
      <div className="insp-head">
        <div className="insp-icon" style={{ background: 'var(--accent)' }}>
          <Copy size={16} />
        </div>
        <div>
          <div className="insp-title">{clips.length} clips seleccionados</div>
          <div className="insp-sub">
            {formatTime(start, project.fps)} → {formatTime(end, project.fps)} · Shift+clic para añadir o quitar
          </div>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        <Section title="Acciones">
          <div className="btn-row">
            <button className="btn sm" title="Dividir los seleccionados en el cabezal (S)" onClick={() => splitAt(useEditor.getState().playhead)}>
              <Scissors size={13} /> Dividir
            </button>
            <button className="btn sm" title="Duplicar (Ctrl+D)" onClick={duplicateSelected}>
              <Copy size={13} /> Duplicar
            </button>
            <button className="btn sm danger" title="Eliminar (Supr)" onClick={deleteSelected}>
              <Trash2 size={13} /> Eliminar
            </button>
          </div>
        </Section>
        {sound.length > 0 && (
          <Section title={`Audio · ${sound.length} clip${sound.length > 1 ? 's' : ''}`}>
            <SliderField
              label="Volumen"
              value={avg(sound.map((f) => (f.clip as MediaClip).volume))}
              min={0}
              max={2}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => editAll((c) => ((c as MediaClip).volume = v), (c) => c.type === 'audio' || (c.type === 'video' && !(c as MediaClip).audioDetached))}
            />
          </Section>
        )}
        <Section title="Fundidos">
          <SliderField label="Entrada" value={avg(clips.map((f) => f.clip.fadeIn))} min={0} max={3} format={(v) => `${v.toFixed(2)}s`} onChange={(v) => editAll((c) => (c.fadeIn = Math.min(v, c.duration / 2)))} />
          <SliderField label="Salida" value={avg(clips.map((f) => f.clip.fadeOut))} min={0} max={3} format={(v) => `${v.toFixed(2)}s`} onChange={(v) => editAll((c) => (c.fadeOut = Math.min(v, c.duration / 2)))} />
        </Section>
        <Section title="Clips">
          <div className="sub-list">
            {clips.map((f) => {
              const meta = CLIP_META[f.clip.type];
              const name = isTextClip(f.clip) ? f.clip.text : project.assets.find((a) => a.id === (f.clip as MediaClip).assetId)?.name;
              return (
                <button key={f.clip.id} className="multi-item" onClick={() => select(f.clip.id)} title="Seleccionar sólo este clip">
                  <meta.Icon size={12} color={meta.color} />
                  <span className="multi-name">{name}</span>
                  <span className="multi-time">{formatTime(f.clip.start, project.fps)}</span>
                </button>
              );
            })}
          </div>
        </Section>
      </div>
    </>
  );
}

function TransformSection({ clip, project, edit, aspect }: {
  clip: MediaClip | TextClip;
  project: Project;
  edit: (fn: (c: any) => void) => void;
  aspect?: { w: number; h: number };
}) {
  const t = clip.transform;
  const set = (k: keyof Transform, v: number) => edit((c) => (c.transform[k] = v));
  const fill = () => {
    if (!aspect) return;
    const rx = project.width / aspect.w;
    const ry = project.height / aspect.h;
    edit((c) => Object.assign(c.transform, { scale: Math.max(rx, ry) / Math.min(rx, ry), x: project.width / 2, y: project.height / 2, rotation: 0 }));
  };
  return (
    <Section
      title="Transformar"
      extra={
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="btn sm icon ghost" title="Centrar" onClick={() => edit((c) => Object.assign(c.transform, { x: project.width / 2, y: project.height / 2 }))}>
            <Crosshair size={13} />
          </button>
          {aspect && (
            <button className="btn sm icon ghost" title="Rellenar el lienzo" onClick={fill}>
              <Maximize size={13} />
            </button>
          )}
        </div>
      }
    >
      <div className="row">
        <NumberField label="Posición X" value={t.x} step={1} suffix="px" precision={0} onChange={(v) => set('x', v)} />
        <NumberField label="Posición Y" value={t.y} step={1} suffix="px" precision={0} onChange={(v) => set('y', v)} />
      </div>
      <div className="row">
        <NumberField label="Escala" value={t.scale * 100} step={1} min={1} max={1000} suffix="%" precision={0} onChange={(v) => set('scale', v / 100)} />
        <NumberField label="Rotación" value={t.rotation} step={1} suffix="°" precision={1} onChange={(v) => set('rotation', v)} />
      </div>
      <SliderField label="Opacidad" value={t.opacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set('opacity', v)} />
    </Section>
  );
}

function TextSections({ clip, edit }: { clip: TextClip; edit: (fn: (c: any) => void) => void }) {
  const s = clip.style;
  const set = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => edit((c) => (c.style[k] = v));
  return (
    <>
      <Section title={clip.type === 'subtitle' ? 'Subtítulo' : 'Texto'}>
        <textarea className="textarea" value={clip.text} onChange={(e) => edit((c) => (c.text = e.target.value))} />
      </Section>
      <Section title="Tipografía">
        <div className="row one">
          <SelectField label="Fuente" value={s.fontFamily} options={FONTS.map((f) => ({ value: f, label: f }))} onChange={(v) => set('fontFamily', v)} />
        </div>
        <div className="row">
          <NumberField label="Tamaño" value={s.fontSize} min={6} max={600} precision={0} suffix="px" onChange={(v) => set('fontSize', v)} />
          <SelectField
            label="Peso"
            value={s.fontWeight}
            options={[300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: w, label: String(w) }))}
            onChange={(v) => set('fontWeight', v)}
          />
        </div>
        <div className="row">
          <ColorField label="Color" value={s.color} onChange={(v) => set('color', v)} />
          <label className="field">
            <span className="field-label">Estilo</span>
            <div style={{ display: 'flex', gap: 4 }}>
              <Toggle on={s.fontWeight >= 700} title="Negrita" onClick={() => set('fontWeight', s.fontWeight >= 700 ? 400 : 700)}>
                <Bold size={13} />
              </Toggle>
              <Toggle on={s.italic} title="Cursiva" onClick={() => set('italic', !s.italic)}>
                <Italic size={13} />
              </Toggle>
              <Toggle on={s.uppercase} title="Mayúsculas" onClick={() => set('uppercase', !s.uppercase)}>
                <CaseUpper size={13} />
              </Toggle>
            </div>
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span className="field-label">Alineación</span>
            <Segmented
              value={s.align}
              onChange={(v) => set('align', v)}
              options={[
                { value: 'left', icon: <AlignLeft size={13} />, title: 'Izquierda' },
                { value: 'center', icon: <AlignCenter size={13} />, title: 'Centro' },
                { value: 'right', icon: <AlignRight size={13} />, title: 'Derecha' },
              ]}
            />
          </label>
          <NumberField label="Ancho máx." value={s.maxWidth} min={0} precision={0} suffix="px" step={5} onChange={(v) => set('maxWidth', v)} />
        </div>
        <div className="row">
          <NumberField label="Interlineado" value={s.lineHeight} min={0.5} max={4} step={0.05} onChange={(v) => set('lineHeight', v)} />
          <NumberField label="Espaciado" value={s.letterSpacing} step={0.5} precision={1} suffix="px" onChange={(v) => set('letterSpacing', v)} />
        </div>
      </Section>
      <Section title="Contorno y sombra">
        <div className="row">
          <ColorField label="Contorno" value={s.strokeColor} onChange={(v) => set('strokeColor', v)} />
          <NumberField label="Grosor" value={s.strokeWidth} min={0} max={50} precision={1} suffix="px" onChange={(v) => set('strokeWidth', v)} />
        </div>
        <div className="row">
          <ColorField label="Sombra" value={s.shadowColor} onChange={(v) => set('shadowColor', v)} />
          <NumberField label="Desenfoque" value={s.shadowBlur} min={0} max={200} precision={0} suffix="px" onChange={(v) => set('shadowBlur', v)} />
        </div>
      </Section>
      <Section title="Caja de fondo">
        <div className="row">
          <ColorField label="Color" value={s.background} onChange={(v) => set('background', v)} />
          <NumberField label="Radio" value={s.radius} min={0} precision={0} suffix="px" onChange={(v) => set('radius', v)} />
        </div>
        <SliderField label="Opacidad" value={s.backgroundOpacity} min={0} max={1} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => set('backgroundOpacity', v)} />
        <SliderField label="Relleno" value={s.padding} min={0} max={120} step={1} format={(v) => `${v}px`} onChange={(v) => set('padding', v)} />
      </Section>
    </>
  );
}

const RESOLUTIONS = [
  { value: '1920x1080', label: '1920 × 1080 · 16:9 Full HD' },
  { value: '1280x720', label: '1280 × 720 · 16:9 HD' },
  { value: '3840x2160', label: '3840 × 2160 · 16:9 4K' },
  { value: '1080x1920', label: '1080 × 1920 · 9:16 Vertical' },
  { value: '1080x1080', label: '1080 × 1080 · 1:1 Cuadrado' },
  { value: '1080x1350', label: '1080 × 1350 · 4:5 Retrato' },
];

function ProjectInspector({ project }: { project: Project }) {
  const update = useEditor((s) => s.update);
  const res = `${project.width}x${project.height}`;
  const edit = (fn: (p: Project) => void) => update(fn, false);

  /** Cambiar de resolución reescala posiciones y tamaños de texto para que la composición se mantenga. */
  const setResolution = (w: number, h: number) =>
    edit((p) => {
      const sx = w / p.width;
      const sy = h / p.height;
      const sf = Math.min(sx, sy);
      for (const t of p.tracks)
        for (const c of t.clips) {
          if (c.type === 'audio') continue;
          c.transform.x *= sx;
          c.transform.y *= sy;
          if (isTextClip(c)) {
            c.style.fontSize = Math.round(c.style.fontSize * sf);
            c.style.padding = Math.round(c.style.padding * sf);
            c.style.maxWidth = Math.round(c.style.maxWidth * sx);
          }
        }
      p.width = w;
      p.height = h;
    });

  return (
    <>
      <div className="insp-head">
        <div className="insp-icon" style={{ background: 'var(--bg-4)' }}>
          <Film size={16} />
        </div>
        <div>
          <div className="insp-title">Proyecto</div>
          <div className="insp-sub">
            {project.width}×{project.height} · {project.fps} fps · {formatTime(projectDuration(project), project.fps, false)}
          </div>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        <Section title="Lienzo">
          <div className="row one">
            <SelectField
              label="Resolución"
              value={RESOLUTIONS.some((r) => r.value === res) ? res : 'custom'}
              options={[...RESOLUTIONS, ...(RESOLUTIONS.some((r) => r.value === res) ? [] : [{ value: 'custom', label: 'Personalizada' }])]}
              onChange={(v) => {
                if (v === 'custom') return;
                const [w, h] = v.split('x').map(Number);
                setResolution(w, h);
              }}
            />
          </div>
          <div className="row">
            <NumberField label="Ancho" value={project.width} min={16} max={7680} precision={0} suffix="px" onChange={(v) => setResolution(Math.round(v), project.height)} />
            <NumberField label="Alto" value={project.height} min={16} max={7680} precision={0} suffix="px" onChange={(v) => setResolution(project.width, Math.round(v))} />
          </div>
          <div className="row">
            <SelectField
              label="Fotogramas"
              value={project.fps}
              options={[24, 25, 30, 50, 60].map((f) => ({ value: f, label: `${f} fps` }))}
              onChange={(v) => edit((p) => (p.fps = v))}
            />
            <ColorField label="Fondo" value={project.background} onChange={(v) => edit((p) => (p.background = v))} />
          </div>
        </Section>
        <Section title="Atajos">
          <div className="shortcuts">
            <span>Reproducir / pausar</span> <span className="kbd">Espacio</span>
            <span>Dividir clip</span> <span className="kbd">S</span>
            <span>Herramienta selección</span> <span className="kbd">V</span>
            <span>Herramienta cuchilla</span> <span className="kbd">C</span>
            <span>Eliminar</span> <span className="kbd">Supr</span>
            <span>Duplicar</span> <span className="kbd">Ctrl D</span>
            <span>Deshacer / rehacer</span> <span className="kbd">Ctrl Z / Y</span>
            <span>Fotograma ± (1 s con Shift)</span> <span className="kbd">← →</span>
            <span>Zoom línea de tiempo</span> <span className="kbd">Ctrl rueda</span>
            <span>Ir a inicio / final</span> <span className="kbd">Inicio / Fin</span>
          </div>
        </Section>
        <div className="empty">Selecciona un clip en la línea de tiempo o en la vista previa para editar sus propiedades.</div>
      </div>
    </>
  );
}
