#!/usr/bin/env node
import { run } from "./cli.js";
import { nodeVersionProblem } from "./version.js";

const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(2);
}

const { code, out } = await run(process.argv.slice(2));
console.log(out);
process.exit(code);
