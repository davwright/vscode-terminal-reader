// Rasterise resources/icon.svg → resources/icon.png at 128x128.
// VSCode marketplace requires a PNG icon; we keep the SVG as the editable
// source and regenerate the PNG with `npm run icon`.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(__dirname, '..');
const svgPath = path.join(root, 'resources', 'icon.svg');
const pngPath = path.join(root, 'resources', 'icon.png');

const svg = fs.readFileSync(svgPath);
const png = new Resvg(svg, {
  fitTo: { mode: 'width', value: 128 },
  background: 'rgba(0,0,0,0)',
  font: { loadSystemFonts: false }
}).render().asPng();

fs.writeFileSync(pngPath, png);
process.stdout.write(`wrote ${path.relative(root, pngPath)} (${png.length} bytes)\n`);
