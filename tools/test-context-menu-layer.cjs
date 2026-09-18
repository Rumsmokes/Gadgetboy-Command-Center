const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src/lib/contextMenuLayer.ts');
assert.equal(fs.existsSync(entry), true, 'A shared context-menu layer policy must protect menus opened inside modal windows.');

const result = esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false });
const mod = { exports: {} };
new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require);
const { resolveContextMenuZIndex, resolveSubmenuViewportLayout, CONTEXT_MENU_LAYER } = mod.exports;

assert.ok(CONTEXT_MENU_LAYER > 100500, 'The shared menu layer must sit above the app modal stack.');
assert.equal(resolveContextMenuZIndex(), CONTEXT_MENU_LAYER);
assert.equal(resolveContextMenuZIndex(50), CONTEXT_MENU_LAYER, 'Unsafe legacy overrides must be raised to the shared menu layer.');
assert.equal(resolveContextMenuZIndex(100700), 100700, 'A deliberately higher overlay must remain higher.');
assert.deepEqual(
  resolveSubmenuViewportLayout({ anchorTop: 750, submenuHeight: 320, viewportHeight: 800, gap: 8 }),
  { top: 472, maxHeight: 320 },
  'A submenu opened near the bottom must shift upward until its last option is visible.',
);
assert.deepEqual(
  resolveSubmenuViewportLayout({ anchorTop: 120, submenuHeight: 1000, viewportHeight: 800, gap: 8 }),
  { top: 8, maxHeight: 784 },
  'A submenu taller than the viewport must stay inside it and expose a scrollable height.',
);

console.log('Context-menu layer checks passed.');
