import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import express from 'express';
import multer from 'multer';
import type { Asset, AssetKind, ExportOptions, Project } from '../shared/types.ts';
import { makeProxy, makeThumb, makeWaveform, needsProxy, probe } from './ffmpeg.ts';
import { getJob, startExport } from './export.ts';
import { ProjectStore, migrateLegacy, uid } from './project-store.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = process.env.VEDITOR_DATA ? path.resolve(process.env.VEDITOR_DATA) : path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
const PORT = Number(process.env.PORT ?? 3001);

migrateLegacy(DATA);
const store = new ProjectStore(DATA);
const app = express();
app.use(express.json({ limit: '200mb' }));

// Los archivos se sirven siempre desde la carpeta del proyecto abierto
const staticFor = (dir: () => string) => {
  const cache = new Map<string, express.Handler>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const d = dir();
    if (!cache.has(d)) cache.set(d, express.static(d));
    cache.get(d)!(req, res, next);
  };
};
app.use('/files/media', staticFor(() => store.mediaDir));
app.use('/files/cache', staticFor(() => store.cacheDir));

// ---- Proyecto abierto + sincronización en vivo ----
app.get('/api/project', (_req, res) => {
  res.json({ version: store.version, project: store.project, folder: store.folder });
});

app.put('/api/project', (req, res) => {
  const { project, clientId } = req.body as { project: Project; clientId: string };
  if (!project || !Array.isArray(project.tracks)) {
    res.status(400).json({ error: 'proyecto inválido' });
    return;
  }
  const version = store.update(project, clientId ?? 'anon');
  if (version === null) res.status(409).json({ error: 'El proyecto abierto cambió' });
  else res.json({ version });
});

app.get('/api/events', (_req, res) => store.subscribe(res));

// ---- Gestión de proyectos ----
const handle = (fn: (req: express.Request) => unknown) => (req: express.Request, res: express.Response) => {
  try {
    res.json(fn(req) ?? { ok: true });
  } catch (e) {
    console.warn(`[api] ${req.method} ${req.path}:`, (e as Error).message);
    res.status(400).json({ error: (e as Error).message });
  }
};

app.get('/api/projects', handle(() => ({ projects: store.list(), active: store.folder })));
app.post('/api/projects', handle((req) => {
  const folder = store.create(String(req.body?.name || 'Proyecto sin título'));
  store.open(folder);
  return { folder };
}));
app.post('/api/projects/open', handle((req) => store.open(String(req.body?.folder))));
app.post('/api/projects/rename', handle((req) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) throw new Error('Nombre vacío');
  store.rename(name);
  return { folder: store.folder };
}));
app.post('/api/projects/duplicate', handle((req) => ({ folder: store.duplicate(String(req.body?.folder)) })));
app.delete('/api/projects/:folder', handle((req) => store.trash(String(req.params.folder))));

// ---- Sesión: qué está mirando el usuario (lo lee Claude) ----
app.put('/api/session', (req, res) => {
  const { playhead, selectedId, selectedIds, playing } = req.body ?? {};
  fs.writeFileSync(store.sessionFile, JSON.stringify({ playhead, selectedId, selectedIds, playing, updatedAt: new Date().toISOString() }, null, 2));
  res.json({ ok: true });
});

// ---- Captura de la vista previa: Claude la pide, el navegador la envía ----
const CLAUDE_DIR = path.join(DATA, 'claude');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
const pendingSnapshots = new Map<string, (r: { file: string; playhead: number }) => void>();

app.post('/api/snapshot', async (_req, res) => {
  const id = uid();
  const result = await new Promise<{ file: string; playhead: number } | null>((resolve) => {
    const timeout = setTimeout(() => {
      pendingSnapshots.delete(id);
      resolve(null);
    }, 5000);
    pendingSnapshots.set(id, (r) => {
      clearTimeout(timeout);
      resolve(r);
    });
    store.broadcast('snapshot', { id });
  });
  if (!result) res.status(504).json({ error: 'No hay ningún editor abierto que responda' });
  else res.json(result);
});

app.post('/api/snapshot/:id', (req, res) => {
  const done = pendingSnapshots.get(req.params.id);
  if (!done) {
    res.status(404).end();
    return;
  }
  pendingSnapshots.delete(req.params.id);
  const file = path.join(CLAUDE_DIR, 'view.png');
  fs.writeFileSync(file, Buffer.from(String(req.body.image).split(',')[1], 'base64'));
  done({ file, playhead: req.body.playhead });
  res.json({ ok: true });
});

// ---- Subida y análisis de medios (se copian a <proyecto>/media) ----
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, store.mediaDir),
    filename: (_req, file, cb) => cb(null, uid() + path.extname(file.originalname).toLowerCase()),
  }),
  limits: { fileSize: 8 * 1024 ** 3 },
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'falta archivo' });
    return;
  }
  const cache = store.cacheDir;
  const id = path.parse(file.filename).name;
  const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
  try {
    const info = await probe(file.path);
    const kind: AssetKind = !info.hasVideo ? 'audio' : info.isStill ? 'image' : 'video';
    if (!info.hasVideo && !info.hasAudio) throw new Error('El archivo no contiene audio ni video');
    const asset: Asset = {
      id,
      name,
      kind,
      file: file.filename,
      url: `/files/media/${file.filename}`,
      duration: kind === 'image' ? 5 : info.duration,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio && kind !== 'image',
      size: file.size,
    };
    if (kind === 'image') asset.thumb = asset.url;
    if (kind === 'video') {
      await makeThumb(file.path, path.join(cache, `${id}.jpg`), Math.min(1, info.duration / 2));
      asset.thumb = `/files/cache/${id}.jpg`;
      if (needsProxy(info)) {
        await makeProxy(file.path, path.join(cache, `${id}.proxy.mp4`));
        asset.url = `/files/cache/${id}.proxy.mp4`;
      }
    }
    if (asset.hasAudio) {
      await makeWaveform(file.path, path.join(cache, `${id}.wave.png`)).then(
        () => (asset.waveform = `/files/cache/${id}.wave.png`),
        (e) => console.warn('[waveform]', e.message),
      );
    }
    res.json(asset);
  } catch (e) {
    fs.rmSync(file.path, { force: true });
    res.status(422).json({ error: (e as Error).message });
  }
});

// ---- Exportación (a <proyecto>/exports) ----
const jobDirs = new Map<string, string>();

app.post('/api/export', (req, res) => {
  const { project, renders, options } = req.body as {
    project: Project;
    renders: Record<string, string>;
    options: ExportOptions;
  };
  const id = uid();
  const jobDir = path.join(store.exportsDir, id);
  fs.mkdirSync(jobDir, { recursive: true });
  jobDirs.set(id, jobDir);
  const textRenders: Record<string, string> = {};
  for (const [clipId, dataUrl] of Object.entries(renders ?? {})) {
    const f = path.join(jobDir, `text_${clipId.replace(/[^\w-]/g, '')}.png`);
    fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
    textRenders[clipId] = f;
  }
  fs.writeFileSync(path.join(jobDir, 'project.json'), JSON.stringify(project, null, 2));
  try {
    const job = startExport({
      id, project, mediaDir: store.mediaDir, jobDir, textRenders,
      options: { crf: options?.crf ?? 20, preset: options?.preset ?? 'veryfast' },
    });
    res.json(job);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.get('/api/export/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) res.status(404).json({ error: 'no existe' });
  else res.json(job);
});

app.get('/api/export/:id/download', (req, res) => {
  const dir = jobDirs.get(req.params.id) ?? path.join(store.exportsDir, path.basename(req.params.id));
  const f = path.join(dir, 'output.mp4');
  if (!fs.existsSync(f)) {
    res.status(404).end();
    return;
  }
  if (req.query.inline) {
    res.sendFile(f);
    return;
  }
  const name = (store.project.name || 'video').replace(/[^\w\- ]+/g, '').trim() || 'video';
  res.download(f, `${name}.mp4`);
});

// ---- Producción: servir el build del cliente ----
const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^(?!\/api|\/files).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}

app.listen(PORT, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  console.log(`[veditor] API en http://localhost:${PORT}${lan ? `  (LAN: ${lan})` : ''} · proyecto: "${store.folder}"`);
});
