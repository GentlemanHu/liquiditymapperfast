// Write the script language's published reference into src/app/public/ (served at the site's root): script-reference.md for people and AI
// assistants, scripts.json for programs, llms.txt for agents. Run after a change to the language: npm run reference. A test fails while these
// files differ from what src/app/script/lang/reference.ts makes.
import fs from 'node:fs';
import path from 'node:path';
import { llmsText, referenceData, referenceMarkdown } from '../src/app/script/lang/reference.ts';

const dir = path.resolve('src/app/public');
fs.writeFileSync(path.join(dir, 'script-reference.md'), referenceMarkdown());
fs.writeFileSync(path.join(dir, 'scripts.json'), `${JSON.stringify(referenceData(), null, 1)}\n`);
fs.writeFileSync(path.join(dir, 'llms.txt'), llmsText());
console.log(`wrote script-reference.md, scripts.json and llms.txt to ${dir}`);
