import { readFileSync } from 'fs';
const file = './frontend/src/components/analysis/AnalysisPanel.jsx';
const lines = readFileSync(file, 'utf8').split('\n');

// Trace line-by-line within region with imbalanced divs
function traceRegion(startLine, endLine) {
  let depth = 0;
  for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i];
    const opens = (line.match(/<div[\s>]/g) || []).length;
    const closes = (line.match(/<\/div>/g) || []).length;
    const prevDepth = depth;
    depth += opens - closes;
    if (opens !== closes || n === startLine || n === endLine) {
      console.log(`L${n} open=${opens} close=${closes} d=${prevDepth}->${depth}: ${line.trimEnd().slice(0, 80)}`);
    }
  }
  console.log(`Final depth in region: ${depth}`);
}

console.log('\n=== Timeline Region (1560-1805) ===');
traceRegion(1560, 1805);
