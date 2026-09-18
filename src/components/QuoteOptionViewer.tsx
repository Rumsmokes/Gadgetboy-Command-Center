import React, { useEffect, useRef, useState } from 'react';

type OptionImage = { id: string; name: string; url: string };

export default function QuoteOptionViewer({ onClose }: { onClose: () => void }) {
  const [images, setImages] = useState<OptionImage[]>([]);
  const [presenting, setPresenting] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const imagesRef = useRef<OptionImage[]>([]);

  useEffect(() => { imagesRef.current = images; }, [images]);
  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.url);
  }, []);

  const addFiles = (files: FileList | File[]) => {
    const next = Array.from(files).filter(file => file.type.startsWith('image/')).map(file => ({
      id: crypto.randomUUID(),
      name: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '),
      url: URL.createObjectURL(file),
    }));
    if (next.length) setImages(current => [...current, ...next]);
  };
  const remove = (id: string) => setImages(current => {
    const target = current.find(image => image.id === id);
    if (target) URL.revokeObjectURL(target.url);
    return current.filter(image => image.id !== id);
  });
  const move = (index: number, direction: -1 | 1) => setImages(current => {
    const target = index + direction;
    if (target < 0 || target >= current.length) return current;
    const next = current.slice();
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {}
  };

  return (
    <div ref={rootRef} className="fixed inset-0 z-[80] flex flex-col bg-[#09090b] text-zinc-100" onClick={event => event.stopPropagation()}>
      <header className="flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-950 px-4 py-3">
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
      </header>

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
