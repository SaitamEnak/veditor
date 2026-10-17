/** Referencia al canvas de la vista previa, para que Claude pueda pedir una captura exacta de lo que ves. */
export const previewCanvas: { current: HTMLCanvasElement | null } = { current: null };

/**
 * Suelta todos los videos/audios de la vista previa (cierra sus descargas). El servidor lo pide antes de
 * renombrar la carpeta del proyecto: en Windows no se puede mientras haya archivos abiertos.
 * La vista previa los vuelve a crear sola cuando los necesita.
 */
export const previewMedia: { release: () => void } = { release: () => {} };
