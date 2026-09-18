export const CONTEXT_MENU_LAYER = 100600;

export function resolveContextMenuZIndex(requested?: number): number {
  const value = Number(requested);
  return Number.isFinite(value) ? Math.max(CONTEXT_MENU_LAYER, value) : CONTEXT_MENU_LAYER;
}

export function resolveSubmenuViewportLayout(input: { anchorTop: number; submenuHeight: number; viewportHeight: number; gap?: number }) {
  const gap = Math.max(0, Number(input.gap ?? 8));
  const viewportHeight = Math.max(gap * 2, Number(input.viewportHeight) || 0);
  const maxHeight = Math.max(0, viewportHeight - gap * 2);
  const submenuHeight = Math.min(Math.max(0, Number(input.submenuHeight) || 0), maxHeight);
  const top = Math.max(gap, Math.min(Number(input.anchorTop) || 0, viewportHeight - submenuHeight - gap));
  return { top, maxHeight: Math.min(Math.max(0, Number(input.submenuHeight) || 0), maxHeight) };
}
