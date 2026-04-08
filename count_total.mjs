import { readFileSync } from 'fs';
function countDivs(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];
    const opens = (line.match(/<div[\s>]/g) || []).length;
    const closes = (line.match(/<\/div>/g) || []).length;
    if (opens !== closes) depth += opens - closes;
  }
  return depth;
}
console.log('Current:', countDivs('./frontend/src/components/analysis/AnalysisPanel.jsx'));
console.log('Original:', countDivs('./orig_ap.jsx'));
