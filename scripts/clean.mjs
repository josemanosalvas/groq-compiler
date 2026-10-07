// Removes build output before compiling, so deleted sources leave no stale files.
import { rmSync } from "node:fs";

for (const path of process.argv.slice(2)) rmSync(path, { force: true, recursive: true });
