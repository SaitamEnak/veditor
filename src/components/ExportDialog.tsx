import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, X } from 'lucide-react';
import type { ExportJob, ExportOptions, Project } from '../../shared/types';
import { clipEnd, planLayers, projectDuration } from '../../shared/types';
import { clipLook, drawClipAt, imageSources, loadFonts } from '../lib/render';
import { formatTime } from '../lib/util';
import { useEditor } from '../store';

const QUALITY: Record<string, ExportOptions & { label: string }> = {
  high: { label: 'Alta (CRF 18 · lento)', crf: 18, preset: 'medium' },
  normal: { label: 'Normal (CRF 21)', crf: 21, preset: 'veryfast' },
  draft: { label: 'Borrador (CRF 28 · rápido)', crf: 28, preset: 'ultrafast' },
};

/**
 * Dibuja y sube los cuadros de cada tramo gráfico del plan de capas. Los cuadros idénticos al anterior
 * no se vuelven a dibujar: se devuelve, por tramo, el índice del cuadro subido que usa cada fotograma.
 */
async function renderGfxRuns(project: Project, jobId: string, onProgress: (f: number) => void) {
  const runs = planLayers(project).flatMap((l) => (l.kind === 'gfx' ? [l] : []));
  const total = runs.reduce((n, r) => n + r.k1 - r.k0, 0);
  if (!total) return [];
  await loadFonts(project);
  const sources = await imageSources(project);
  const canvas = document.createElement('canvas');
  canvas.width = project.width;
  canvas.height = project.height;
  const ctx = canvas.getContext('2d')!;
  const inflight = new Set<Promise<void>>();
  let failure: Error | null = null;
  let done = 0;
  const maps: number[][] = [];

  for (const [r, run] of runs.entries()) {
    const map: number[] = [];
    let prevLook: string | null = null;
    let lastSrc = 0;
    for (let k = run.k0; k < run.k1; k++) {
      if (failure) throw failure;
      const i = k - run.k0;
      const t = k / project.fps;
      const active = run.clips.filter((c) => t >= c.start && t < clipEnd(c));
      const look = active.map((c) => clipLook(c, t)).join('|');
      if (look !== prevLook) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const c of active) drawClipAt(ctx, c, t, project, sources);
        const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo codificar un cuadro'))), 'image/png'));
        const p: Promise<void> = fetch(`/api/export/${jobId}/frame?run=${r}&frame=${i}`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: blob })
          .then(async (res) => {
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Error al subir un cuadro');
          })
          .catch((e) => void (failure = e))
          .finally(() => inflight.delete(p));
        inflight.add(p);
        if (inflight.size >= 6) await Promise.race(inflight);
        prevLook = look;
        lastSrc = i;
      }
      map.push(lastSrc);
      if (++done % 5 === 0) onProgress(done / total);
    }
    maps.push(map);
  }
  await Promise.all(inflight);
  if (failure) throw failure;
  onProgress(1);
  return maps;
}

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const [quality, setQuality] = useState('normal');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'running' | 'done' | 'error'>('idle');
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState('');
  const [drawn, setDrawn] = useState(0);
  const duration = projectDuration(project);

  useEffect(() => {
    if (phase !== 'running' || !job) return;
    const iv = setInterval(async () => {
      const r = await fetch(`/api/export/${job.id}`);
      const j: ExportJob = await r.json();
      setJob(j);
      if (j.status === 'done') setPhase('done');
      if (j.status === 'error') {
        setPhase('error');
        setError(j.error ?? 'Error desconocido');
      }
    }, 500);
    return () => clearInterval(iv);
  }, [phase, job?.id]);

  const start = async () => {
    setPhase('preparing');
    setError('');
    setDrawn(0);
    try {
      const prep = await fetch('/api/export/prepare', { method: 'POST' });
      const { id } = await prep.json();
      // Las capas gráficas se dibujan en el navegador, cuadro a cuadro, con el mismo código que la vista previa
      const gfx = await renderGfxRuns(project, id, setDrawn);
      const { label: _, ...options } = QUALITY[quality];
      const r = await fetch(`/api/export/${id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, gfx, options }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      setJob(j);
      setPhase('running');
    } catch (e) {
      setPhase('error');
      setError((e as Error).message);
    }
  };

  const pct = Math.round((phase === 'preparing' ? drawn : (job?.progress ?? 0)) * 100);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && phase !== 'running' && onClose()}>
      <div className="modal">
        <div className="modal-head">
          Exportar video
          <button className="btn icon ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="summary">
            <div>
              <b>
                {project.width}×{project.height}
              </b>
              <span>Resolución</span>
            </div>
            <div>
              <b>{project.fps} fps</b>
              <span>Fotogramas</span>
            </div>
            <div>
              <b>{formatTime(duration, project.fps, false)}</b>
              <span>Duración</span>
            </div>
          </div>
          <label className="field">
            <span className="field-label">Calidad · MP4 (H.264 + AAC)</span>
            <select className="select" value={quality} disabled={phase === 'running'} onChange={(e) => setQuality(e.target.value)}>
              {Object.entries(QUALITY).map(([k, q]) => (
                <option key={k} value={k}>
                  {q.label}
                </option>
              ))}
            </select>
          </label>

          {(phase === 'preparing' || phase === 'running') && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 12, color: 'var(--text-1)' }}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Loader2 size={13} className="spin" /> {phase === 'preparing' ? 'Dibujando capas gráficas…' : 'Renderizando con FFmpeg…'}
                </span>
                <span>{pct}%</span>
              </div>
              <div className="progress">
                <div style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {phase === 'done' && job?.url && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--ok)' }}>
                <CheckCircle2 size={16} /> Exportación completada
              </div>
              <video className="result-video" src={job.url.replace('/download', '/download?inline=1')} controls />
            </>
          )}

          {phase === 'error' && <div className="error-box">{error}</div>}
        </div>
        <div className="modal-foot">
          {phase === 'done' && job?.url ? (
            <a className="btn primary" href={job.url} download>
              <Download size={14} /> Descargar MP4
            </a>
          ) : (
            <button className="btn primary" onClick={start} disabled={duration === 0 || phase === 'preparing' || phase === 'running'}>
              {phase === 'error' ? 'Reintentar' : 'Exportar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
