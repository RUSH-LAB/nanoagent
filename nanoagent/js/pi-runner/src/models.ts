#!/usr/bin/env node

/**
 * The models PI can run (index.ts's catalog), as one JSON document on stdout. Its build imports
 * index.js beside it rather than bundling a second copy of PI.
 */
import {catalog} from "./index.js";

process.stdout.write(`${JSON.stringify(await catalog())}\n`);
