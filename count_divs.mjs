import { readFileSync } from 'fs';
const lines = readFileSync('./frontend/src/components/analysis/AnalysisPanel.jsx', 'utf8').split('\n');
let depth = 0;
let inReturn = false;
for (let i = 0; i < lines.length; i++) {
  const n = i + 1;
  const line = lines[i];
  if (n >= 855 && !inReturn && /^  return \(/.test(line)) {
    inReturn = true;
    console.log('Main return at L' + n);
  }
  if (!inReturn) continue;
  const opens = (line.match(/<div[\s>]/g) || []).length;
  const closes = (line.match(/<\/div>/g) || []).length;
  depth += opens - closes;
  if (opens || closes) {
    const show = (n >= 1185 && n <= 1215) || (n >= 1795 && n <= 1820) || n > 1975 || depth <= 4;
    if (show) console.log(`L${n} depth=${depth} | ${line.slice(0, 90)}`);
  }
  if (n > 1975 && line.trim()) {
    console.log(`END L${n} d=${depth}: ${JSON.stringify(line)}`);
  }
}
console.log('Final depth:', depth);
