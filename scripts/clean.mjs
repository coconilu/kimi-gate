import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const pkg of ['shared', 'gateway', 'connector']) {
  rmSync(join(root, 'packages', pkg, 'dist'), { recursive: true, force: true });
}
console.log('cleaned dist directories');
