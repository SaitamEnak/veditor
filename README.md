# VEditor

Editor de video colaborativo en el navegador. Usa FFmpeg para analizar los medios y exportar.

```bash
pnpm install
pnpm dev          # web en http://localhost:5173 · API en :3001
```

FFmpeg/FFprobe vienen incluidos (`ffmpeg-static`, `ffprobe-static`). Para usar otros binarios, define `FFMPEG_PATH` / `FFPROBE_PATH`.
Producción: `pnpm build && pnpm start` (todo se sirve en :3001).

## Estructura

| Ruta | Qué hace |
| --- | --- |
| `shared/types.ts` | Modelo del proyecto (pistas, clips, assets), común al cliente y al servidor |
| `server/index.ts` | API: subida y análisis de medios, proyecto, SSE y exportación |
| `server/export.ts` | Convierte el proyecto en un `filter_complex` de FFmpeg |
| `server/project-store.ts` | Proyectos (una carpeta por proyecto en `data/projects/`) y difusión en vivo |
| `src/store.ts` | Estado (Zustand): operaciones de edición, undo/redo |
| `src/components/Timeline.tsx` | Línea de tiempo: mover, recortar, cuchilla, snapping, drop |
| `src/components/Preview.tsx` | Composición en canvas y transformación directa sobre el lienzo |
| `src/lib/render.ts` | Dibujo de textos (lo usan la vista previa y la exportación) |

## Colaboración con Claude

El editor está pensado para que edites el video **con Claude**:

- Cada proyecto es una carpeta autocontenida: `data/projects/<nombre>/` con `project.json`, `media/` (todos los archivos fuente), `cache/` y `exports/`. Se gestionan desde el botón **Proyectos**; los borrados van a `data/papelera/`.
- Tú editas en la interfaz. Claude edita el `project.json` del proyecto abierto y sus cambios llegan en vivo. Arriba aparece un aviso con un botón **Deshacer**, los clips modificados se resaltan y todo se puede deshacer con Ctrl+Z.
- Tu cabezal y tu selección se guardan en el `session.json` del proyecto. Así, cuando dices "corta aquí" o "este clip", Claude sabe a qué te refieres.
- Claude usa estas herramientas para ver el proyecto:

| Comando | Qué hace |
| --- | --- |
| `pnpm claude state` | Resumen de pistas y clips, y qué estás mirando |
| `pnpm claude frame [t]` | Renderiza con FFmpeg el fotograma en `t` (sin textos) y lo guarda en `data/claude/frame.png` |
| `pnpm claude projects` | Lista los proyectos e indica el abierto |
| `pnpm claude snapshot` | Captura exacta de tu vista previa, con textos (requiere el editor abierto), en `data/claude/view.png` |

## Exportación

Los textos y subtítulos se rasterizan a PNG en el navegador (WYSIWYG) y FFmpeg los superpone.
Los videos e imágenes se escalan, rotan, se les aplica opacidad y fundidos, y se superponen de la pista inferior a la superior. El audio se mezcla con `amix`.
Cada exportación guarda `graph.txt`, `command.txt` y `ffmpeg.log` en `data/exports/<id>/` para depurar.
