import React, { useEffect, useRef, useState } from 'react';

type OptionImage = { id: string; name: string; url: string };

export default function QuoteOptionViewer({ onClose }: { onClose: () => void }) {
  const [images, setImages] = useState<OptionImage[]>([]);
  const [presenting, setPresenting] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [importError, setImportError] = useState('');
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);

  const readImage = (file: File) => new Promise<OptionImage>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const url = String(reader.result || '');
      if (!url.startsWith('data:image/')) { reject(new Error(`${file.name} is not a supported image.`)); return; }
      resolve({ id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '), url });
    };
    reader.readAsDataURL(file);
  });

  const addFiles = async (files: FileList | File[]) => {
    const supported = Array.from(files).filter(file => file.type.startsWith('image/'));
    if (!supported.length) { setImportError('Choose an image file (PNG, JPG, WEBP, or similar).'); return; }
    setImportError('');
    const results = await Promise.allSettled(supported.map(readImage));
    const next = results.filter((result): result is PromiseFulfilledResult<OptionImage> => result.status === 'fulfilled').map(result => result.value);
    if (next.length) setImages(current => [...current, ...next]);
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) setImportError(failed.map(result => result.status === 'rejected' ? result.reason?.message || 'An image could not be read.' : '').join(' '));
  };
  const remove = (id: string) => setImages(current => {
    const target = current.find(image => image.id === id);
    return current.filter(image => image.id !== id);
  });
  const move = (index: number, direction: -1 | 1) => setImages(current => {
    const target = index + direction;
    if (target < 0 || target >= current.length) return current;
    const next = current.slice();
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  useEffect(() => {
    const syncFullscreen = async () => {
      if (window.api?.getFullScreen) setIsNativeFullscreen(!!(await window.api.getFullScreen()));
      else setIsNativeFullscreen(!!document.fullscreenElement);
    };
    void syncFullscreen();
    const timer = window.setInterval(() => void syncFullscreen(), 400);
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => { window.clearInterval(timer); document.removeEventListener('fullscreenchange', syncFullscreen); };
  }, []);

  const fullscreen = async () => {
    try {
      if (window.api?.setFullScreen) {
        await window.api.setFullScreen(!isNativeFullscreen);
        setIsNativeFullscreen(!isNativeFullscreen);
        return;
      }
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {
      setImportError('Fullscreen could not be started on this display.');
    }
  };

  return (
    <div ref={rootRef} className={`quote-option-viewer fixed inset-0 z-[80] flex flex-col bg-[#09090b] text-zinc-100 ${isNativeFullscreen ? 'gb-client-display-fullscreen' : ''}`} onClick={event => event.stopPropagation()}>
      <header className="quote-option-toolbar flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-[#39FF14]">Option Viewer</h2>
          <p className="text-xs text-zinc-400">Image-only presentation for cases, colors, styles, and other customer choices.</p>
        </div>
        {presenting ? (
          <button className="rounded border border-zinc-700 bg-zinc-800 px-4 py-2 font-semibold" onClick={() => setPresenting(false)}>Edit Options</button>
        ) : (
          <button className="rounded bg-[#39FF14] px-4 py-2 font-bold text-black disabled:opacity-40" disabled={!images.length} onClick={() => setPresenting(true)}>Show Preview</button>
        )}
        <button className="rounded border border-violet-500 bg-violet-950 px-4 py-2 font-semibold" onClick={() => void fullscreen()}>Fullscreen</button>
        <button className="rounded border border-zinc-700 bg-zinc-800 px-4 py-2 font-semibold" onClick={onClose}>Close</button>
      </header><style>{`.quote-option-viewer:fullscreen .quote-option-toolbar,.quote-option-viewer.gb-client-display-fullscreen .quote-option-toolbar{display:none}`}</style>

      {presenting ? (
        <main className="flex-1 overflow-y-auto bg-zinc-100 p-3 sm:p-6">
          <div className="mx-auto grid w-full max-w-[1800px] grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {images.map((image, index) => (
              <article key={image.id} className="overflow-hidden rounded-2xl border border-zinc-300 bg-white shadow-lg">
                <div className="flex min-h-[320px] items-center justify-center bg-white p-3 sm:min-h-[440px]">
                  <img src={image.url} alt={image.name || `Option ${index + 1}`} className="max-h-[70vh] w-full object-contain" />
                </div>
                <div className="border-t border-zinc-200 px-4 py-3 text-center text-lg font-bold capitalize text-zinc-900">{image.name || `Option ${index + 1}`}</div>
              </article>
            ))}
          </div>
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <label
            className="mx-auto flex min-h-40 max-w-5xl cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-violet-500 bg-violet-950/20 p-6 text-center hover:bg-violet-950/35"
            onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
            onDrop={event => { event.preventDefault(); addFiles(event.dataTransfer.files); }}
          >
            <strong className="text-lg">Drop images here or choose files</strong>
            <span className="mt-1 text-sm text-zinc-400">Select several case designs or product options at once.</span>
            {importError ? <span role="alert" className="mt-2 text-sm text-red-200">{importError}</span> : null}
            <input className="sr-only" type="file" accept="image/*" multiple onChange={event => { if (event.target.files) addFiles(event.target.files); event.currentTarget.value = ''; }} />
          </label>
          {images.length ? (
            <div className="mx-auto mt-5 grid max-w-6xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {images.map((image, index) => (
                <article key={image.id} className="rounded-xl border border-zinc-700 bg-zinc-900 p-3">
                  <img src={image.url} alt={image.name} className="h-48 w-full rounded-lg bg-white object-contain" />
                  <input className="mt-3 w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 capitalize" value={image.name} onChange={event => setImages(current => current.map(item => item.id === image.id ? { ...item, name: event.target.value } : item))} aria-label={`Option ${index + 1} label`} />
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    <button className="rounded bg-zinc-800 px-2 py-2 disabled:opacity-30" disabled={index === 0} onClick={() => move(index, -1)}>Move left</button>
                    <button className="rounded bg-zinc-800 px-2 py-2 disabled:opacity-30" disabled={index === images.length - 1} onClick={() => move(index, 1)}>Move right</button>
                    <button className="rounded bg-red-950 px-2 py-2 text-red-200" onClick={() => remove(image.id)}>Remove</button>
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </main>
      )}
    </div>
  );
}
