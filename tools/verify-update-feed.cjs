const https = require('https');

const repo = 'Rumsmokes/Gadgetboy-Command-Center';
const currentVersion = String(process.argv[2] || '0.5.7').replace(/^v/i, '');

function requestJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'gbpos-update-feed-verifier',
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

function parts(value) {
  return String(value || '').replace(/^v/i, '').split(/[+-]/)[0].split('.').map(Number);
}

function newer(candidate, current) {
  const a = parts(candidate);
  const b = parts(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

(async () => {
  const release = await requestJson(`https://api.github.com/repos/${repo}/releases/latest`);
  const version = String(release.tag_name || '').replace(/^v/i, '');
  const names = new Set((release.assets || []).map((asset) => asset.name));
  const required = [
    `Android-APK-universal-${version}.apk`,
    `GB-POS-installerx64-${version}.exe`,
    `GB-POS-installerx64-${version}.exe.blockmap`,
    'latest.yml',
  ];
  const missing = required.filter((name) => !names.has(name));
  if (!newer(version, currentVersion)) throw new Error(`Latest ${version} is not newer than ${currentVersion}.`);
  if (missing.length) throw new Error(`Missing update assets: ${missing.join(', ')}`);
  console.log(`Update feed valid: ${currentVersion} -> ${version}`);
  console.log(required.join('\n'));
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
