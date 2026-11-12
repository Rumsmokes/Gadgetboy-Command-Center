const assert = require('node:assert/strict');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'Node' } });

const { resolveWarrantyPolicy } = require('../src/lib/warrantyPolicy.ts');

assert.deepEqual(resolveWarrantyPolicy({ warrantyDays: 90 }, null), { enabled: true, days: 90, source: 'repair' });
assert.deepEqual(resolveWarrantyPolicy({ warrantyExcluded: true }, { days: 90 }), { enabled: false, days: null, source: 'none' });
assert.deepEqual(resolveWarrantyPolicy({}, { days: 60 }), { enabled: true, days: 60, source: 'family' });
assert.deepEqual(resolveWarrantyPolicy({ warrantyDays: 0 }, { days: 60 }), { enabled: false, days: null, source: 'none' });

console.log('Warranty policy checks passed.');
