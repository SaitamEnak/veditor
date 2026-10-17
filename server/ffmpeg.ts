import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path || 'ffprobe';

export function run(bin: string, args: string[], onStdout?: (chunk: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      onStdout?.(s);
    });
    p.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.split('\n').slice(-15).join('\n') || `exit ${code}`));
    });
  });
}

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec?: string;
  formatName: string;
  isStill: boolean;
}

export async function probe(file: string): Promise<ProbeResult> {
  const out = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const data = JSON.parse(out);
  const streams: any[] = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === 'audio');
  const formatName: string = data.format?.format_name ?? '';
  const duration = parseFloat(data.format?.duration ?? v?.duration ?? a?.duration ?? '0') || 0;
  const stillCodecs = ['png', 'mjpeg', 'webp', 'bmp', 'gif', 'tiff'];
  const isStill = !!v && (formatName.includes('image2') || formatName.includes('_pipe') || (stillCodecs.includes(v.codec_name) && duration < 0.1));
  let width = v?.width ?? 0;
  let height = v?.height ?? 0;
  const rot = Math.abs(parseInt(v?.tags?.rotate ?? v?.side_data_list?.find((d: any) => d.rotation != null)?.rotation ?? '0', 10));
  if (rot === 90 || rot === 270) [width, height] = [height, width];
  return { duration, width, height, hasVideo: !!v, hasAudio: !!a, videoCodec: v?.codec_name, formatName, isStill };
}

export function makeThumb(input: string, output: string, at: number) {
  return run(FFMPEG, ['-y', '-v', 'error', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', output]);
}

export function makeWaveform(input: string, output: string) {
  return run(FFMPEG, [
    '-y', '-v', 'error', '-i', input,
    '-filter_complex', 'aformat=channel_layouts=mono,showwavespic=s=1600x100:colors=white:scale=sqrt',
    '-frames:v', '1', output,
  ]);
}

/** El navegador sólo reproduce ciertos códecs; para el resto generamos un proxy H.264 de vista previa. */
export function needsProxy(p: ProbeResult) {
  const okCodec = ['h264', 'vp8', 'vp9', 'av1'].includes(p.videoCodec ?? '');
  const okFormat = /mp4|mov|webm|matroska/.test(p.formatName);
  return p.hasVideo && !(okCodec && okFormat);
}

export function makeProxy(input: string, output: string) {
  return run(FFMPEG, [
    '-y', '-v', 'error', '-i', input,
    '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', output,
  ]);
}
