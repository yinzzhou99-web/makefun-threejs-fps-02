// Dustline Depot — hand-in program (Node 22, standard library only).
//
// The grader runs this file with the repository mounted read-only and a writable output directory
// (MAKEFUN_OUTPUT_DIR names it outside the grader, /output inside). The program's whole job is the
// hand-in: copy the playable game (game/) and the maker's screenshots (screenshots/) out of the repo,
// then seal them into dossier.json with the kit's vendored builder, vendor/makefun-threejs.ts — the
// gate rebuilds that dossier with the same library and compares the two byte for byte, so the caps
// below restate the gate's own limits exactly. Nothing here touches the network, the clock or a
// random source: the same repository always produces the same dossier.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The gate's caps, restated: dossier text 160 KiB, 3–4 screenshots of at most 256 KiB each,
// the game tree at most 993 entries and 48 MiB with no path over 1,000 bytes.
const CAPS = {
  text_max_bytes: 163_840,
  screenshots: { max: 4, max_bytes: 262_144 },
  game_max_files: 993,
  game_max_bytes: 50_331_648,
  game_path_max_bytes: 1_000,
};
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The visible (non-dot) file names directly inside a directory, or [] when it is absent. */
function visibleFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isFile());
}

const shots = visibleFiles(join(repoDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`dustline depot: screenshots/ holds ${shots.length} images: the hand-in needs 3 or 4\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!SHOT_NAME.test(name)) {
    process.stderr.write(`dustline depot: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
cpSync(join(repoDir, 'game'), join(outDir, 'game'), { recursive: true });
cpSync(join(repoDir, 'screenshots'), join(outDir, 'screenshots'), { recursive: true });

// Written last, from the copies, so the dossier describes exactly what was handed in.
writeFileSync(join(outDir, 'dossier.json'), buildDossier(outDir, CAPS));

process.stdout.write(`dustline depot: handed in game/ and ${shots.length} screenshots; dossier.json sealed in ${outDir}\n`);
