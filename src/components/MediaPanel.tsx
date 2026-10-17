import { useRef, useState } from 'react';
import { AlertCircle, Download, FileText, Film, FolderOpen, Image as ImageIcon, Loader2, Music, Plus, Subtitles, Trash2, Type, Upload } from 'lucide-react';
import type { Asset, TextClip } from '../../shared/types';
import { clipEnd } from '../../shared/types';
import { parseSubtitles, toSrt } from '../lib/srt';
import { formatBytes, formatTime, uid } from '../lib/util';
import { useEditor } from '../store';

export const DND_ASSET = 'application/x-veditor-asset';
export const DND_TEXT = 'application/x-veditor-text';

type Tab = 'media' | 'text' | 'subs';

export function MediaPanel() {
  const [tab, setTab] = useState<Tab>('media');
  return (
    <aside className="panel panel-left">
      <div className="tabs">
        <button className={`tab ${tab === 'media' ? 'active' : ''}`} onClick={() => setTab('media')}>
          <FolderOpen size={14} /> Medios
        </button>
        <button className={`tab ${tab === 'text' ? 'active' : ''}`} onClick={() => setTab('text')}>
          <Type size={14} /> Texto
        </button>
        <button className={`tab ${tab === 'subs' ? 'active' : ''}`} onClick={() => setTab('subs')}>
          <Subtitles size={14} /> Subtítulos
        </button>
      </div>
      <div className="panel-body">
        {tab === 'media' && <MediaTab />}
        {tab === 'text' && <TextTab />}
        {tab === 'subs' && <SubsTab />}
      </div>
    </aside>
  );
}

async function uploadFile(file: File) {
  const id = uid('u');
  const st = useEditor;
  st.setState((s) => ({ uploads: [...s.uploads, { id, name: file.name }] }));
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? 'Error al subir');
    st.getState().addAsset(data as Asset);
    st.setState((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
  } catch (e) {
    st.setState((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, error: (e as Error).message } : u)) }));
    setTimeout(() => st.setState((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) })), 8000);
  }
}

function MediaTab() {
  const assets = useEditor((s) => s.project.assets);
  const uploads = useEditor((s) => s.uploads);
  const { addAssetClip, removeAsset } = useEditor.getState();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const handleFiles = (files: FileList | null) => {
    if (files) for (const f of Array.from(files)) uploadFile(f);
  };

  return (
    <>
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <Upload size={20} />
        <strong>Importar medios</strong>
        Arrastra videos, audios o imágenes
        <input ref={inputRef} type="file" multiple hidden accept="video/*,audio/*,image/*,.mkv,.mov" onChange={(e) => handleFiles(e.target.files)} />
      </div>

      {uploads.map((u) => (
        <div key={u.id} className={`uploading ${u.error ? 'error' : ''}`}>
          {u.error ? <AlertCircle size={14} /> : <Loader2 size={14} className="spin" />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {u.error ? `${u.name}: ${u.error}` : `Procesando ${u.name}…`}
          </span>
        </div>
      ))}

      <div className="panel-title">
        Biblioteca <span>{assets.length}</span>
      </div>
      {assets.length === 0 && !uploads.length && <div className="empty">Aún no hay medios en el proyecto.</div>}
      <div className="asset-grid">
        {assets.map((a) => (
          <div
            key={a.id}
            className="asset"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_ASSET, a.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onDoubleClick={() => addAssetClip(a)}
            title={`${a.name}\nDoble clic o arrastra a la línea de tiempo`}
          >
            <div
              className={`asset-thumb ${a.kind === 'audio' ? 'wave' : ''}`}
              style={{ backgroundImage: a.thumb ? `url(${a.thumb})` : a.waveform ? `url(${a.waveform})` : undefined }}
            >
              {!a.thumb && !a.waveform && <AssetIcon kind={a.kind} />}
              <span className="asset-badge">{a.kind === 'image' ? 'IMG' : formatTime(a.duration, 30, false)}</span>
            </div>
            <div className="asset-actions">
              <button className="btn sm icon" title="Añadir en el cabezal" onClick={() => addAssetClip(a)}>
                <Plus size={13} />
              </button>
              <button className="btn sm icon danger" title="Quitar del proyecto (y sus clips)" onClick={() => removeAsset(a.id)}>
                <Trash2 size={13} />
              </button>
            </div>
            <div className="asset-meta">
              <div className="asset-name">{a.name}</div>
              <div className="asset-sub">
                {a.kind !== 'audio' ? `${a.width}×${a.height} · ` : ''}
                {formatBytes(a.size)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function AssetIcon({ kind }: { kind: Asset['kind'] }) {
  if (kind === 'audio') return <Music size={22} />;
  if (kind === 'image') return <ImageIcon size={22} />;
  return <Film size={22} />;
}

/** Presets de texto: se aplican sobre el estilo por defecto al crear el clip. */
export const TEXT_PRESETS: { id: string; kind: 'text' | 'subtitle'; label: string; text: string; preview: React.CSSProperties; style?: Partial<TextClip['style']> }[] = [
  { id: 'title', kind: 'text', label: 'Título', text: 'Título', preview: { font: '900 22px Montserrat', textShadow: '0 2px 8px #000' } },
  {
    id: 'outline', kind: 'text', label: 'Contorno', text: 'IMPACTO',
    preview: { font: '28px "Bebas Neue"', color: '#ffe14d', WebkitTextStroke: '1px #000' },
    style: { fontFamily: 'Bebas Neue', fontWeight: 400, color: '#ffe14d', strokeWidth: 6, strokeColor: '#000000', shadowBlur: 0, fontSize: 150 },
  },
  {
    id: 'box', kind: 'text', label: 'Etiqueta', text: 'Etiqueta',
    preview: { font: '700 15px Poppins', background: '#7c6cff', padding: '4px 10px', borderRadius: 6 },
    style: { fontFamily: 'Poppins', fontWeight: 700, fontSize: 64, background: '#7c6cff', backgroundOpacity: 1, shadowBlur: 0, padding: 24 },
  },
  {
    id: 'elegant', kind: 'text', label: 'Elegante', text: 'Elegante',
    preview: { font: 'italic 700 20px "Playfair Display"' },
    style: { fontFamily: 'Playfair Display', fontWeight: 700, italic: true, fontSize: 100, shadowBlur: 10 },
  },
  {
    id: 'marker', kind: 'text', label: 'Rotulador', text: '¡Hola!',
    preview: { font: '20px "Permanent Marker"', color: '#ff6ab0' },
    style: { fontFamily: 'Permanent Marker', fontWeight: 400, color: '#ff6ab0', fontSize: 110, shadowBlur: 0 },
  },
  { id: 'sub', kind: 'subtitle', label: 'Subtítulo', text: 'Subtítulo', preview: { font: '600 13px Inter', background: 'rgba(0,0,0,.65)', padding: '3px 8px', borderRadius: 4 } },
];

export function addPreset(presetId: string, opts?: { trackId?: string; start?: number }) {
  const preset = TEXT_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  const st = useEditor.getState();
  st.addTextClip(preset.kind, opts);
  const id = useEditor.getState().selectedId;
  if (id)
    useEditor.getState().updateClip(id, (c) => {
      const t = c as TextClip;
      t.text = preset.text;
      if (preset.style) {
        const scale = useEditor.getState().project.height / 1080;
        Object.assign(t.style, preset.style);
        if (preset.style.fontSize) t.style.fontSize = Math.round(preset.style.fontSize * scale);
      }
    }, false);
}

function TextTab() {
  return (
    <>
      <div className="panel-title">Estilos de texto</div>
      <div className="preset-grid">
        {TEXT_PRESETS.map((p) => (
          <div
            key={p.id}
            className="preset"
            draggable
            title="Clic para añadir en el cabezal o arrastra a la línea de tiempo"
            onDragStart={(e) => e.dataTransfer.setData(DND_TEXT, p.id)}
            onClick={() => addPreset(p.id)}
          >
            <span style={p.preview}>{p.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function SubsTab() {
  const tracks = useEditor((s) => s.project.tracks);
  const selectedId = useEditor((s) => s.selectedId);
  const fps = useEditor((s) => s.project.fps);
  const { addTextClip, importCues, updateClip, select, setPlayhead } = useEditor.getState();
  const inputRef = useRef<HTMLInputElement>(null);
  const subs = tracks
    .flatMap((t) => t.clips)
    .filter((c): c is TextClip => c.type === 'subtitle')
    .sort((a, b) => a.start - b.start);

  const exportSrt = () => {
    const blob = new Blob([toSrt(subs.map((s) => ({ start: s.start, end: clipEnd(s), text: s.text })))], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'subtitulos.srt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <>
      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button className="btn" onClick={() => addTextClip('subtitle')}>
          <Plus size={14} /> Añadir
        </button>
        <button className="btn" onClick={() => inputRef.current?.click()}>
          <FileText size={14} /> Importar SRT
        </button>
        <button className="btn icon" title="Exportar .srt" onClick={exportSrt} disabled={!subs.length}>
          <Download size={14} />
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          accept=".srt,.vtt"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) importCues(parseSubtitles(await f.text()));
            e.target.value = '';
          }}
        />
      </div>
      <div className="panel-title">
        Subtítulos <span>{subs.length}</span>
      </div>
      {!subs.length && <div className="empty">Añade subtítulos o importa un archivo .srt / .vtt.</div>}
      <div className="sub-list">
        {subs.map((s) => (
          <div key={s.id} className={`sub-item ${selectedId === s.id ? 'selected' : ''}`}>
            <div
              className="sub-time"
              onClick={() => {
                select(s.id);
                setPlayhead(s.start + 0.001);
              }}
            >
              {formatTime(s.start, fps)}
              <br />
              {formatTime(clipEnd(s), fps)}
            </div>
            <textarea
              value={s.text}
              onFocus={() => {
                select(s.id);
                useEditor.getState().checkpoint();
              }}
              onChange={(e) => updateClip(s.id, (c) => ((c as TextClip).text = e.target.value), false)}
            />
          </div>
        ))}
      </div>
    </>
  );
}
