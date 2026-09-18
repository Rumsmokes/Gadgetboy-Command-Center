import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveContextMenuZIndex, resolveSubmenuViewportLayout } from '../lib/contextMenuLayer';
import { closeMenuBeforeAction } from '../lib/reliability';

export type ContextMenuItem =
	| { type?: 'item'; label: string; onClick?: () => void | Promise<void>; disabled?: boolean; danger?: boolean; hint?: string; children?: ContextMenuItem[] }
	| { type: 'separator' }
	| { type: 'header'; label: string };

function isInteractive(item: ContextMenuItem): item is Extract<ContextMenuItem, { type?: 'item' }> {
	return !('type' in item) || item.type === 'item';
}

export default function ContextMenu(props: {
	open: boolean;
	x: number;
	y: number;
	items: ContextMenuItem[];
	onClose: () => void;
	minWidth?: number;
	id?: string;
	zIndex?: number;
}) {
	const { open, x, y, items, onClose, minWidth = 240, id = 'ctx-menu', zIndex } = props;
	const effectiveZIndex = resolveContextMenuZIndex(zIndex);
	const menuRef = useRef<HTMLDivElement | null>(null);
	const submenuRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
	const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);
	const [submenuAnchorTop, setSubmenuAnchorTop] = useState(0);
	const [submenuLayout, setSubmenuLayout] = useState<{ top: number; maxHeight: number } | null>(null);

	const hasItems = useMemo(() => items.some(it => (it as any)?.type !== 'separator'), [items]);

	useLayoutEffect(() => {
		if (!open) {
			setPos(null);
			setOpenSubmenu(null);
			setSubmenuLayout(null);
			return;
		}
		// Start from the latest click position so the first open does not render at 0,0.
		setPos({ left: x, top: y });
	}, [open, x, y]);

	useLayoutEffect(() => {
		if (!open) return;
		const el = menuRef.current;
		if (!el) return;

		const rect = el.getBoundingClientRect();
		const vw = typeof window !== 'undefined' ? window.innerWidth : rect.width;
		const vh = typeof window !== 'undefined' ? window.innerHeight : rect.height;
		const pad = 8;
		const currentLeft = pos?.left ?? x;
		const currentTop = pos?.top ?? y;

		const left = Math.max(pad, Math.min(currentLeft, vw - rect.width - pad));
		const top = Math.max(pad, Math.min(currentTop, vh - rect.height - pad));

		if (left !== currentLeft || top !== currentTop) setPos({ left, top });
	}, [open, pos, x, y]);

	useLayoutEffect(() => {
		if (!open || openSubmenu == null || !submenuRef.current) { setSubmenuLayout(null); return; }
		const rect = submenuRef.current.getBoundingClientRect();
		setSubmenuLayout(resolveSubmenuViewportLayout({ anchorTop: submenuAnchorTop, submenuHeight: rect.height, viewportHeight: window.innerHeight, gap: 8 }));
	}, [open, openSubmenu, submenuAnchorTop]);

	useLayoutEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [open, onClose]);

	if (!open || !hasItems) return null;

	const displayPos = pos || { left: x, top: y };

	return createPortal(
		<>
			<div className="fixed inset-0" style={{ zIndex: effectiveZIndex - 1 }} onMouseDown={onClose} />
			<div
				id={id}
				ref={menuRef}
				className="fixed bg-zinc-900 border border-zinc-700 rounded shadow-xl py-1"
				style={{ left: displayPos.left, top: displayPos.top, minWidth, zIndex: effectiveZIndex }}
				role="menu"
			>
				{items.map((it, idx) => {
					if ((it as any).type === 'separator') {
						return <div key={`sep-${idx}`} className="my-1 border-t border-zinc-800" />;
					}
					if ((it as any).type === 'header') {
						return (
							<div key={`hdr-${idx}`} className="px-3 py-2 text-xs text-zinc-400 select-none">
								{(it as any).label}
							</div>
						);
					}

					const item = it as Extract<ContextMenuItem, { type?: 'item' }>;
					const disabled = !!item.disabled;
					const danger = !!item.danger;

					const hasChildren = !!item.children?.length;
					return (
						<div key={`it-${idx}`} className="relative" onMouseEnter={(event) => { if (hasChildren) { setSubmenuAnchorTop(event.currentTarget.getBoundingClientRect().top); setOpenSubmenu(idx); } }} onMouseLeave={() => hasChildren && setOpenSubmenu(null)}>
						<button
							className={
								`w-full text-left px-3 py-2 flex items-center justify-between gap-3 ` +
								(disabled
									? 'opacity-50 cursor-not-allowed'
									: danger
										? 'hover:bg-red-900/50 text-red-300'
										: 'hover:bg-zinc-800')
							}
							disabled={disabled}
							onClick={async (event) => {
								if (disabled) return;
								if (hasChildren) { setSubmenuAnchorTop((event.currentTarget.parentElement as HTMLElement).getBoundingClientRect().top); setOpenSubmenu(current => current === idx ? null : idx); return; }
								await closeMenuBeforeAction(onClose, item.onClick);
							}}
							role={isInteractive(item) ? 'menuitem' : undefined}
						>
							<span>{item.label}</span>
							{hasChildren ? <span className="text-xs text-zinc-400">▶</span> : item.hint ? <span className="text-xs text-zinc-500">{item.hint}</span> : null}
						</button>
						{hasChildren && openSubmenu === idx ? <div ref={submenuRef} className={`absolute ${displayPos.left + minWidth * 2 > window.innerWidth ? 'right-full mr-1' : 'left-full ml-1'} min-w-60 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 py-1 shadow-xl`} style={{ top: submenuLayout ? submenuLayout.top - submenuAnchorTop : 0, maxHeight: submenuLayout?.maxHeight || 'calc(100vh - 16px)' }} role="menu">{item.children!.map((child, childIndex) => {
							if (child.type === 'separator') return <div key={childIndex} className="my-1 border-t border-zinc-800" />;
							if (child.type === 'header') return <div key={childIndex} className="px-3 py-2 text-xs text-zinc-400">{child.label}</div>;
							return <button key={childIndex} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-zinc-800 disabled:opacity-50" disabled={child.disabled} onClick={async () => { if (!child.disabled) await closeMenuBeforeAction(onClose, child.onClick); }}><span>{child.label}</span>{child.hint ? <span className="text-xs text-zinc-500">{child.hint}</span> : null}</button>;
						})}</div> : null}
						</div>
					);
				})}
			</div>
		</>,
		document.body
	);
}
