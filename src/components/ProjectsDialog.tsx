import { useEffect, useState } from 'react';
import { Copy, FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { useEditor } from '../store';

interface ProjectInfo {
  folder: string;
  name: string;
  updatedAt: string;
  clips: number;
  assets: number;
  active: boolean;
}

const api = async (url: string, method = 'GET', body?: unknown) => {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'Error');
  return j;
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Cada proyecto es una carpeta en data/projects con su JSON y todos sus archivos fuente. */
export function ProjectsDialog({ onClose }: { onClose: () => void }) {
  const tick = useEditor((s) => s.projectsTick);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => api('/api/projects').then((j) => setProjects(j.projects), (e) => setError(e.message));
  useEffect(() => {
    load();
  }, [tick]);

  const run = async (fn: () => Promise<unknown>, close = false) => {
    setError('');
    try {
      await fn();
      if (close) onClose();
      else load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const create = () => run(() => api('/api/projects', 'POST', { name: newName.trim() || 'Proyecto sin título' }), true);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(620px, calc(100vw - 32px))' }}>
        <div className="modal-head">
          Proyectos
          <button className="btn icon ghost" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              placeholder="Nombre del nuevo proyecto"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              style={{ height: 30 }}
            />
            <button className="btn primary" onClick={create}>
              <Plus size={14} /> Nuevo
            </button>
          </div>

          {error && <div className="error-box">{error}</div>}

          <div className="project-list">
            {projects.map((p) => (
              <div key={p.folder} className={`project-row ${p.active ? 'active' : ''}`}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="project-row-name">
                    {p.name}
                    {p.active && <span className="badge">abierto</span>}
                  </div>
                  <div className="insp-sub">
                    data/projects/{p.folder} · {p.clips} clips · {p.assets} archivos · {fmtDate(p.updatedAt)}
                  </div>
                </div>
                {confirmDelete === p.folder ? (
                  <>
                    <span className="insp-sub">¿Mover a la papelera?</span>
                    <button className="btn sm danger" onClick={() => run(() => api(`/api/projects/${encodeURIComponent(p.folder)}`, 'DELETE'))}>
                      Sí
                    </button>
                    <button className="btn sm" onClick={() => setConfirmDelete(null)}>
                      No
                    </button>
                  </>
                ) : (
                  <>
                    {!p.active && (
                      <button className="btn sm" onClick={() => run(() => api('/api/projects/open', 'POST', { folder: p.folder }), true)}>
                        <FolderOpen size={13} /> Abrir
                      </button>
                    )}
                    <button className="btn sm icon" title="Duplicar (copia también los archivos)" onClick={() => run(() => api('/api/projects/duplicate', 'POST', { folder: p.folder }))}>
                      <Copy size={13} />
                    </button>
                    <button
                      className="btn sm icon danger"
                      title={p.active ? 'Abre otro proyecto para poder borrar este' : 'Mover a la papelera'}
                      disabled={p.active}
                      onClick={() => setConfirmDelete(p.folder)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="insp-sub">
            Cada proyecto es una carpeta autocontenida con sus archivos. Los borrados van a <code>data/papelera</code>.
          </div>
        </div>
      </div>
    </div>
  );
}
