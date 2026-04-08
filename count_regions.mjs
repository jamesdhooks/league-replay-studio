import { readFileSync } from 'fs';
const file = './frontend/src/components/analysis/AnalysisPanel.jsx';
const lines = readFileSync(file, 'utf8').split('\n');

function countRegion(startLine, endLine, label) {
  let opens = 0, closes = 0;
  for (let i = startLine - 1; i < endLine && i < lines.length; i++) {
    const line = lines[i];
    // Skip lines that are clearly inside template literals / strings
    opens += (line.match(/<div[\s>]/g) || []).length;
    closes += (line.match(/<\/div>/g) || []).length;
  }
  console.log(`${label} (L${startLine}-${endLine}): opens=${opens}, closes=${closes}, net=${opens-closes}`);
}

// Key regions based on our analysis
countRegion(856, 863, 'Main return start to ResizableSidebar');
countRegion(863, 1185, 'ResizableSidebar props');
countRegion(1185, 1192, 'Center+right opening');
countRegion(1192, 1560, 'Preview content');
countRegion(1560, 1805, 'Timeline section');
countRegion(1805, 1980, 'Fragment2 (right panel)');
countRegion(1980, 1992, 'Closing area');

// Cumulative depth
let depth = 0;
const positions = [862, 1184, 1191, 1559, 1804, 1979, 1991];
for (let i = 0; i < lines.length; i++) {
  const n = i + 1;
  const line = lines[i];
  const opens = (line.match(/<div[\s>]/g) || []).length;
  const closes = (line.match(/<\/div>/g) || []).length;
  depth += opens - closes;
  if (positions.includes(n)) {
    console.log(`  Depth at L${n}: ${depth}`);
  }
}
console.log(`Final depth: ${depth}`);
