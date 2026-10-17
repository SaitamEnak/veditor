import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2, X } from 'lucide-react';
import type { ExportJob, ExportOptions, TextClip } from '../../shared/types';
import { isTextClip, projectDuration } from '../../shared/types';
import { renderTextPng } from '../lib/render';
import { formatTime } from '../lib/util';
import { useEditor } from '../store';

const QUALITY: Record<string, ExportOptions & { label: string }> = {
  high: { label: 'Alta (CRF 18 · lento)', crf: 18, preset: 'medium' },
  normal: { label: 'Normal (CRF 21)', crf: 21, preset: 'veryfast' },
  draft: { label: 'Borrador (CRF 28 · rápido)', crf: 28, preset: 'ultrafast' },
};

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const [quality, setQuality] = useState('normal');
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'running' | 'done' | 'error'>('idle');
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState('');
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
    try {
      // Los textos se rasterizan en el navegador para que el resultado sea idéntico a la vista previa
      const renders: Record<string, string> = {};
      const texts = project.tracks
        .filter((t) => t.kind === 'visual' && !t.hidden)
        .flatMap((t) => t.clips)
        .filter((c): c is TextClip => isTextClip(c));
      for (const c of texts) renders[c.id] = await renderTextPng(c, project);
      const { label: _, ...options } = QUALITY[quality];
      const r = await fetch('/api/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, renders, options }),
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

  const pct = Math.round((job?.progress ?? 0) * 100);

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
                  <Loader2 size={13} className="spin" /> {phase === 'preparing' ? 'Preparando textos…' : 'Renderizando con FFmpeg…'}
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
