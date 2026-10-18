# VEditor: editor de video que el usuario y Claude usan juntos

The user edits in the browser GUI. Claude edits the project file. This is not multi-user collaboration: it is always the user plus Claude. Talk to the user in Spanish.

**Projects:** each project is a self-contained folder `data/projects/<folder>/` holding `project.json`, `media/` (every source file it uses), `cache/`, `exports/` and `session.json`. The open project is recorded in `data/active.json`. List them with `pnpm claude projects`. Never put a project's sources outside its folder.

## Setup at the start of a session

1. Check whether the dev server is running: `curl -s localhost:3001/api/project > /dev/null && echo ok`.
   If it is not, start `pnpm dev` in the background. Web: http://localhost:5173, API: :3001.
2. Before acting on any editing request, run `pnpm claude state` to see the project, the user's playhead and the selected clip.

## How Claude edits

- **The project is `data/projects/<open>/project.json`; `pnpm claude state` prints the path.** Edit it directly, for example with a short Node script that reads it, changes it and writes it back once.
  The server detects the change and the GUI receives it live. The user sees a "Claude actualizó el proyecto" notice and can undo with Ctrl+Z.
- The data model is in `shared/types.ts`:
  - Times are in seconds. `tracks[0]` is the top layer.
  - Each clip has `start`, `duration`, and for media `in`, which is the offset into the source file.
  - `transform.x/y` is the clip's center in canvas pixels.
  - `volumeKeys[].t` is in source time.
- Keep ids unique (`c` + random) and do not overlap clips on the same track.
- "aquí", "ahora" and "este clip" refer to `playhead` and `selectedId` in that project's `session.json`, which `pnpm claude state` shows.
  "estos clips" and "los seleccionados" refer to `selectedIds`: the user selects several clips with Shift+click.

## How Claude sees

- `pnpm claude frame [t]`: frame at timeline time t, without text, saved to `data/claude/frame.png`. Read the image afterwards.
- `pnpm claude snapshot`: exact capture of the user's preview with text, saved to `data/claude/view.png`. It needs the editor open in a tab.
- `pnpm claude snapshot t…` / `pnpm claude sheet t…`: graphic layers (text, shapes, images; no video) at those times without moving the user's playhead; `sheet` tiles them into `data/claude/sheet.png` to review animations. Also needs an editor tab.
- Animation: visual clips accept `keyframes` (local time, see `Keyframe` in `shared/types.ts`); `shape` clips are rectangles, ellipses or SVG paths. Export draws graphic layers in the browser frame by frame (`planLayers`), so preview and MP4 match.
- Claude cannot hear audio. For audio analysis, run FFmpeg (`silencedetect`, `volumedetect`) using the binary path from `server/ffmpeg.ts`.

## Code changes

- Use pnpm, never npm.
- `pnpm typecheck` must pass.
- When editing a source file, write it once. Then confirm Vite serves the new version: `curl -s localhost:5173/src/<file> | grep <symbol>`. Several rapid writes leave Vite serving a stale version; `touch` the file if that happens.
- Before deleting or overwriting the user's media in `data/projects/*/media`, ask.
- Do not open or switch projects through the API without asking: it changes what the user sees in the GUI.
