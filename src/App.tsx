import { useEffect, useState } from 'react';
import { projectDuration } from '../shared/types';
import { ExportDialog } from './components/ExportDialog';
import { Inspector } from './components/Inspector';
import { MediaPanel } from './components/MediaPanel';
import { Preview } from './components/Preview';
import { Timeline } from './components/Timeline';
import { TopBar } from './components/TopBar';
import { useEditor } from './store';

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]')) return;
      const st = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      const fps = st.project.fps;
      const k = e.key.toLowerCase();

      if (mod && k === 'z') {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        st.redo();
      } else if (mod && k === 'd') {
        e.preventDefault();
        st.duplicateSelected();
      } else if (mod) {
        return;
      } else if (e.code === 'Space') {
        e.preventDefault();
        st.setPlaying(!st.playing);
      } else if (k === 's') st.splitAt(st.playhead);
      else if (k === 'v') st.setTool('select');
      else if (k === 'c' || k === 'b') st.setTool('razor');
      else if (k === 'delete' || k === 'backspace') st.deleteSelected();
      else if (k === 'escape') st.select(null);
      else if (k === 'arrowleft') st.setPlayhead(st.playhead - (e.shiftKey ? 1 : 1 / fps));
      else if (k === 'arrowright') st.setPlayhead(st.playhead + (e.shiftKey ? 1 : 1 / fps));
      else if (k === 'home') st.setPlayhead(0);
      else if (k === 'end') st.setPlayhead(projectDuration(st.project));
      else if (k === '+' || k === '=') st.setZoom(st.zoom * 1.25);
      else if (k === '-') st.setZoom(st.zoom / 1.25);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const [exporting, setExporting] = useState(false);
  const [timelineH, setTimelineH] = useState(340);
  useShortcuts();

  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY;
    const h0 = timelineH;
    const move = (ev: PointerEvent) => setTimelineH(Math.min(window.innerHeight - 260, Math.max(160, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="app" style={{ '--timeline-h': `${timelineH}px` } as React.CSSProperties}>
      <TopBar onExport={() => setExporting(true)} />
      <MediaPanel />
      <Preview />
      <Inspector />
      <div className="resizer" onPointerDown={startResize} />
      <Timeline />
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </div>
  );
}
