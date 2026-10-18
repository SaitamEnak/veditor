import { previewCanvas, previewMedia } from './lib/previewCanvas';
import { renderGraphicsFrame } from './lib/render';
import { useEditor } from './store';
import { uid } from './lib/util';

/**
 * Colaboración tú ↔ Claude:
 * - El proyecto vive en data/project.json. Tus cambios se guardan ahí (PUT con debounce).
 * - Claude edita ese archivo; el servidor lo detecta y llega por SSE como cambio de Claude (deshacible).
 * - Tu cabezal y tu selección se publican en data/session.json para que Claude sepa qué estás mirando.
 * - Claude puede pedir una captura de la vista previa (evento "snapshot").
 */
export const clientId = uid('client-');
const CLAUDE_IDS = new Set(['external', 'claude']);

export async function refreshFolder() {
  try {
    const { active } = await (await fetch('/api/projects')).json();
    useEditor.setState({ folder: active });
  } catch {}
}

export function startSync() {
  refreshFolder();
  const es = new EventSource('/api/events?name=editor');
  useEditor.setState({ connection: 'connecting' });
  es.onopen = () => useEditor.setState({ connection: 'online' });
  es.onerror = () => useEditor.setState({ connection: 'offline' });
  let flashTimer: ReturnType<typeof setTimeout> | undefined;

  es.addEventListener('project', (e) => {
    const d = JSON.parse((e as MessageEvent).data);
    if (d.clientId === clientId) return;
    const st = useEditor.getState();
    if (CLAUDE_IDS.has(d.clientId) && st.ready) {
      st.applyClaude(d.project);
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => useEditor.setState({ flashIds: [] }), 2500);
    } else st.applyRemote(d.project);
  });

  es.addEventListener('projects', (e) => {
    const { folder } = JSON.parse((e as MessageEvent).data);
    useEditor.setState((s) => ({ folder, projectsTick: s.projectsTick + 1 }));
  });

  es.addEventListener('release-media', () => {
    useEditor.getState().setPlaying(false);
    previewMedia.release();
  });

  es.addEventListener('snapshot', async (e) => {
    const { id, t } = JSON.parse((e as MessageEvent).data) as { id: string; t?: number };
    const st = useEditor.getState();
    const c = typeof t === 'number' ? await renderGraphicsFrame(st.project, t) : previewCanvas.current;
    if (!c) return;
    await fetch(`/api/snapshot/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: c.toDataURL('image/png'), playhead: st.playhead, t }),
    }).catch(() => {});
  });

  // ---- Guardado del proyecto ----
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = async () => {
    const { project } = useEditor.getState();
    useEditor.setState({ saving: true });
    try {
      const r = await fetch('/api/project', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, clientId }),
      });
      // 409: el proyecto abierto cambió mientras guardábamos; se descarta (no es un error a reintentar)
      if (r.status === 409) {
        useEditor.setState({ dirty: false });
        return;
      }
      if (!r.ok) throw new Error(await r.text());
      if (useEditor.getState().project === project) useEditor.setState({ dirty: false });
    } catch (err) {
      console.error('[sync] error al guardar', err);
      timer = setTimeout(save, 2000);
    } finally {
      useEditor.setState({ saving: false });
    }
  };

  // ---- Estado de sesión (cabezal / selección) para Claude ----
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  const pushSession = () => {
    const { playhead, selectedId, selectedIds, playing } = useEditor.getState();
    fetch('/api/session', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playhead, selectedId, selectedIds, playing }),
    }).catch(() => {});
  };

  useEditor.subscribe((s, prev) => {
    if (s.project !== prev.project && s.dirty) {
      clearTimeout(timer);
      timer = setTimeout(save, 250);
    }
    if (s.selectedIds !== prev.selectedIds || s.selectedId !== prev.selectedId || s.playing !== prev.playing || (!s.playing && s.playhead !== prev.playhead)) {
      clearTimeout(sessionTimer);
      sessionTimer = setTimeout(pushSession, 300);
    }
  });
}
