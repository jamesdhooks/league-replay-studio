import { readFileSync } from 'fs';
const file = process.argv[2] || './frontend/src/components/analysis/AnalysisPanel.jsx';
const lines = readFileSync(file, 'utf8').split('\n');

// First find the main AnalysisPanel return
let returnLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (/^  return \(/.test(lines[i])) {
    // Skip helper function returns (PhaseCard etc) - look for the big one
    if (i > 700 && i < 1000) { returnLine = i + 1; break; }
  }
}
if (returnLine === -1) {
  // Fallback: find last return( before line 900
  for (let i = 0; i < 1000 && i < lines.length; i++) {
    if (/^  return \(/.test(lines[i])) returnLine = i + 1;
  }
}
console.log(`Main return found at line: ${returnLine}`);

// Find the closing })  after the main return
let endLine = -1;
let depth = 0;
for (let i = returnLine; i < lines.length; i++) {
  const n = i + 1;
  const line = lines[i];
  if (/^ *\)\s*$/.test(line) && i > returnLine + 100) { endLine = n; break; }
}
console.log(`Component ends around line: ${endLine}`);

function countRegion(startLine, endLine, label) {
  let opens = 0, closes = 0;
  for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
    const line = lines[i];
    opens += (line.match(/<div[\s>]/g) || []).length;
    closes += (line.match(/<\/div>/g) || []).length;
  }
  console.log(`  ${label} (L${startLine}-${endLine}): open=${opens}, close=${closes}, net=${opens-closes}`);
}
