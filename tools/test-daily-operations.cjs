const assert=require('node:assert/strict');const fs=require('node:fs');
const source=fs.readFileSync('src/components/DailyOperationsWindow.tsx','utf8');
assert.match(source,/dailyOperationsChecklists/);assert.match(source,/30 \* 86400000/);assert.match(source,/Technician/);assert.match(source,/Opening/);assert.match(source,/Closing/);assert.match(source,/Read-only/);
const center=fs.readFileSync('src/components/CommandCenter.tsx','utf8');assert.match(center,/Opening \/ Closing Checklist/);assert.match(center,/DailyOperationsWindow/);
console.log('Daily operations checklist wiring passed.');
