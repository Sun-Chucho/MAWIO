const fs = require('fs');
const path = require('path');

const DIRECTORY = path.join('c:', 'Users', 'PC', 'Desktop', 'MAWIO', 'src');

function replaceInDirectory(dir) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      replaceInDirectory(fullPath);
    } else if (stat.isFile() && (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') || fullPath.endsWith('.json'))) {
      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes('Orange Hotel') || content.includes('orange hotel') || content.includes('ORANGE HOTEL')) {
        content = content.replace(/Orange Hotel/g, 'MAWIO');
        content = content.replace(/orange hotel/g, 'MAWIO');
        content = content.replace(/ORANGE HOTEL/g, 'MAWIO');
        content = content.replace(/orange-hotel/g, 'mawio');
        fs.writeFileSync(fullPath, content, 'utf-8');
        console.log(`Updated ${fullPath}`);
      }
    }
  }
}

replaceInDirectory(DIRECTORY);
console.log("Done.");
