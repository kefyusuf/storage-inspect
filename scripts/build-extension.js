import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "extension", "lib");
mkdirSync(outDir, { recursive: true });

// The MV3 bundle can only import files inside its own folder, so we mirror the
// CLI's pure modules here. Single source of truth stays in src/.
const shared = ["filter.js", "report.js"];
const header =
  "// GENERATED — do not edit. Copy of src/<file> for the MV3 extension bundle.\n" +
  "// Refresh with `npm run build:extension`.\n\n";

for (const name of shared) {
  writeFileSync(join(outDir, name), header + readFileSync(join(root, "src", name), "utf8"));
  console.log(`extension/lib/${name} refreshed from src/${name}`);
}
