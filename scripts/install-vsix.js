// Install the built .vsix into VS Code, clean up old ones.
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const expected = `${pkg.name}-${pkg.version}.vsix`;
const vsix = path.join(root, expected);

if (!fs.existsSync(vsix)) {
  console.error(`Expected ${expected} not found. The "vsix" script should produce it.`);
  process.exit(1);
}

const old = fs
  .readdirSync(root)
  .filter((f) => f.endsWith('.vsix') && f !== expected);
if (old.length > 0) {
  for (const f of old) fs.unlinkSync(path.join(root, f));
  console.log(`Cleaned up ${old.length} old .vsix file(s)`);
}

const candidates = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
  path.join(process.env.PROGRAMFILES || '', 'Microsoft VS Code', 'bin', 'code.cmd'),
  'code'
];
const codeCli = candidates.find((c) => c === 'code' || (c && fs.existsSync(c))) || 'code';

console.log('Installing', expected);
execSync(`"${codeCli}" --install-extension "${vsix}" --force`, { stdio: 'inherit' });
