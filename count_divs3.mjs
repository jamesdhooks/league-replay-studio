import { readFileSync } from 'fs';
const file = process.argv[2] || './frontend/src/components/analysis/AnalysisPanel.jsx';
const lines = readFileSync(file, 'utf8').split('\n');
let depth = 0;
let inReturn = false;
const checkpoints = [857, 860, 863, 1000, 1100, 1185, 1187, 1200, 1400, 1600, 1800, 1850, 1900, 1950, 1976, 1985, 1991];
for (let i = 0; i < lines.length; i++) {
  const n = i + 1;
  const line = lines[i];
  if (n >= 855 && !inReturn && /^  return \(/.test(line)) {
    inReturn = true;
    console.log(`L${n}: MAIN RETURN starts. depth=${depth}`);
  }
  if (!inReturn) continue;
  const opens = (line.match(/<div[\s>]/g) || []).length;
  const closes = (line.match(/<\/div>/g) || []).length;
  depth += opens - closes;
  if (checkpoints.includes(n)) {
    console.log(`L${n}: depth=${depth} | ${line.trim().slice(0, 80)}`);
  }
}
console.log('Final depth:', depth);
