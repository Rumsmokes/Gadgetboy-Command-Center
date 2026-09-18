const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'); const root=process.cwd(); const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const manifest=JSON.parse(read('public/manifest.webmanifest')); assert.equal(manifest.display,'standalone'); assert.equal(manifest.start_url,'./'); assert.equal(manifest.icons.length,2);
for(const file of ['public/icons/icon-192.png','public/icons/icon-512.png','public/icons/apple-touch-icon.png']) assert.ok(fs.statSync(path.join(root,file)).size>1000,file);
const html=read('src/mobile.html'); assert.match(html,/apple-touch-icon/); assert.match(html,/manifest\.webmanifest/); assert.match(html,/safe-area-inset/);
assert.match(read('src/workorders/releasePrint.ts'),/durantTicket=/); const url='Web Interface: https://rumsmokes.github.io/Gadgetboy-Command-Center'; assert.ok(read('docs/WEB-INTERFACE.txt').includes(url)); assert.ok(read('.github/workflows/release.yml').includes(url));
console.log('PWA, iOS icon, Durant deep link, and release URL checks passed.');
