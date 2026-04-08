import { readFileSync } from 'fs';
const file = process.argv[2] || './frontend/src/components/analysis/AnalysisPanel.jsx';
const lines = readFileSync(file, 'utf8').split('\n');
let depth = 0;
let inReturn = false;
for (let i = 0; i < lines.length; i++) {
  const n = i + 1;
  const line = lines[i];
  if (n >= 855 && !inReturn && /^  return \(/.test(line)) {
    inReturn = true;
  }
  if (!inReturn) continue;
  const opens = (line.match(/<div[\s>]/g) || []).length;
  const closes = (line.match(/<\/div>/g) || []).length;
  depth += opens - closes;
}
console.log('Final depth:', depth);
