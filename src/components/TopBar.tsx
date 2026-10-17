import { useEffect, useState } from 'react';
import { ChevronDown, Clapperboard, Loader2, Redo2, Sparkles, Undo2 } from 'lucide-react';
import { ProjectsDialog } from './ProjectsDialog';
import { useEditor } from '../store';

export function TopBar({ onExport }: { onExport: () => void }) {
  const name = useEditor((s) => s.project.name);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const connection = useEditor((s) => s.connection);
  const saving = useEditor((s) => s.saving || s.dirty);
  const { undo, redo } = useEditor.getState();
  const [text, setText] = useState(name);
  const [showProjects, setShowProjects] = useState(false);
  useEffect(() => setText(name), [name]);

  /** Renombrar el proyecto también renombra su carpeta en data/projects */
  const rename = async () => {
    const n = text.trim();
    if (!n || n === name) {
      setText(name);
      return;
    }
    const r = await fetch('/api/projects/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) });
    if (!r.ok) setText(name);
  };

  return (
    <header className="topbar">
      <div className="logo">
        <div className="logo-mark">
          <Clapperboard size={15} color="white" />
        </div>
        VEditor
      </div>
      <button className="btn ghost projects-btn" title="Proyectos" onClick={() => setShowProjects(true)}>
        Proyectos <ChevronDown size={13} />
      </button>
      <input
        className="project-name"
        value={text}
        title="Nombre del proyecto (también renombra su carpeta)"
        onChange={(e) => setText(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(name);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <button className="btn icon ghost" title="Deshacer (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
        <Undo2 size={16} />
      </button>
      <button className="btn icon ghost" title="Rehacer (Ctrl+Y)" disabled={!canRedo} onClick={redo}>
        <Redo2 size={16} />
      </button>
      <div className="status">
        {connection === 'online' ? (
          saving ? (
            <>
              <Loader2 size={12} className="spin" /> Guardando…
            </>
          ) : (
            <>
              <span className="dot online" /> Guardado
            </>
          )
        ) : (
          <>
            <span className={`dot ${connection === 'offline' ? 'offline' : ''}`} />
            {connection === 'offline' ? 'Sin conexión con el servidor' : 'Conectando…'}
          </>
        )}
      </div>
      <div className="spacer" />
      <ClaudeNotice />
      <button className="btn primary" onClick={onExport}>
        Exportar
      </button>
      {showProjects && <ProjectsDialog onClose={() => setShowProjects(false)} />}
    </header>
  );
}

/** Aviso cuando Claude modifica el proyecto, con opción de deshacer. */
function ClaudeNotice() {
  const change = useEditor((s) => s.claudeChange);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!change) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), 10000);
    return () => clearTimeout(t);
  }, [change?.at]);

  const parts = change
    ? [change.changed && `${change.changed} clip${change.changed > 1 ? 's' : ''} modificado${change.changed > 1 ? 's' : ''}`, change.removed && `${change.removed} eliminado${change.removed > 1 ? 's' : ''}`].filter(Boolean)
    : [];

  return (
    <div className={`claude-pill ${visible ? 'active' : ''}`} title="Claude edita data/project.json y los cambios llegan aquí en vivo">
      <Sparkles size={13} />
      {visible && change ? (
        <>
          <span>Claude actualizó el proyecto{parts.length ? ` · ${parts.join(', ')}` : ''}</span>
          <button
            className="btn sm ghost"
            onClick={() => {
              useEditor.getState().undo();
              setVisible(false);
            }}
          >
            Deshacer
          </button>
        </>
      ) : (
        <span>Claude</span>
      )}
    </div>
  );
}
