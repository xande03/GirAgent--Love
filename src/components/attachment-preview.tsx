import { useState, useCallback } from "react";
import { X, FileText, ZoomIn } from "lucide-react";

type Att = { name: string; mime: string; dataUrl: string; size: number };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── Lightbox overlay ── */
function Lightbox({ src, name, onClose }: { src: string; name: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={src}
          alt={name}
          className="max-h-[85vh] max-w-[85vw] rounded-lg object-contain"
        />
        <div className="absolute right-2 top-2 flex items-center gap-2">
          <span className="rounded-md bg-black/60 px-2 py-1 font-mono text-xs text-white backdrop-blur-sm">
            {name}
          </span>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-sm transition-colors hover:bg-destructive"
            aria-label="Fechar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Single image thumbnail card ── */
function ImageCard({
  att,
  onRemove,
  onPreview,
}: {
  att: Att;
  onRemove: () => void;
  onPreview: () => void;
}) {
  return (
    <div className="group relative flex w-20 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-background sm:w-24">
      <button
        onClick={onPreview}
        className="relative aspect-square w-full overflow-hidden"
        aria-label={`Visualizar ${att.name}`}
      >
        <img
          src={att.dataUrl}
          alt={att.name}
          className="h-full w-full object-cover transition-transform group-hover:scale-105"
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
          <ZoomIn className="h-4 w-4 text-white opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
      </button>
      <div className="flex items-center justify-between gap-1 px-1.5 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
          {att.name}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          aria-label={`Remover ${att.name}`}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/* ── Single file (non-image) chip ── */
function FileChip({ att, onRemove }: { att: Att; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{att.name}</p>
        <p className="font-mono text-[10px] text-muted-foreground">{formatBytes(att.size)}</p>
      </div>
      <button
        onClick={onRemove}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        aria-label={`Remover ${att.name}`}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* ══════════════════════════════════════════
   Composer attachments (pending upload)
   ══════════════════════════════════════════ */
export function ComposerAttachments({
  attachments,
  onRemove,
}: {
  attachments?: Att[] | null | undefined;
  onRemove: (name: string) => void;
}) {
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);

  const list = attachments ?? [];
  const images = list.filter((a) => a.mime?.startsWith("image/"));
  const files = list.filter((a) => !a.mime?.startsWith("image/"));

  if (list.length === 0) return null;

  return (
    <>
      {images.length > 0 && (
        <div className="mb-3 flex gap-2 overflow-x-auto pb-1">
          {images.map((a) => (
            <ImageCard
              key={a.name}
              att={a}
              onRemove={() => onRemove(a.name)}
              onPreview={() => setLightbox({ src: a.dataUrl, name: a.name })}
            />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {files.map((a) => (
            <FileChip key={a.name} att={a} onRemove={() => onRemove(a.name)} />
          ))}
        </div>
      )}
      {lightbox && (
        <Lightbox
          src={lightbox.src}
          name={lightbox.name}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}

/* ══════════════════════════════════════════
   Chat message attachments (already sent)
   ══════════════════════════════════════════ */
export function MessageAttachments({ attachments }: { attachments?: Att[] | null | undefined }) {
  const [lightbox, setLightbox] = useState<{ src: string; name: string } | null>(null);

  const list = attachments ?? [];
  const images = list.filter((a) => a.mime?.startsWith("image/"));
  const files = list.filter((a) => !a.mime?.startsWith("image/"));

  if (list.length === 0) return null;

  return (
    <>
      {images.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {images.map((a) => (
            <button
              key={a.name}
              onClick={() => setLightbox({ src: a.dataUrl, name: a.name })}
              className="group relative aspect-square overflow-hidden rounded-lg border border-border"
              aria-label={`Visualizar ${a.name}`}
            >
              <img
                src={a.dataUrl}
                alt={a.name}
                className="h-full w-full object-cover transition-transform group-hover:scale-105"
              />
              <div className="absolute inset-0 flex items-end bg-gradient-to-t from-black/50 to-transparent">
                <span className="w-full truncate px-2 pb-1.5 font-mono text-[10px] text-white">
                  {a.name}
                </span>
              </div>
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/20">
                <ZoomIn className="h-5 w-5 text-white opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {files.map((a) => (
            <span
              key={a.name}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/50 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>{a.name}</span>
              <span className="text-[10px] opacity-60">{formatBytes(a.size)}</span>
            </span>
          ))}
        </div>
      )}
      {lightbox && (
        <Lightbox
          src={lightbox.src}
          name={lightbox.name}
          onClose={() => setLightbox(null)}
        />
      )}
    </>
  );
}
