// A harness with zero model calls: computes the probe's digest locally and writes the result atomically.
const fs = require("node:fs");
const { sha256 } = require("@noble/hashes/sha256");
const { bytesToHex, utf8ToBytes } = require("@noble/hashes/utils");

const request = JSON.parse(fs.readFileSync(process.env.RUSH_REQUEST, "utf8"));
const digest = bytesToHex(sha256(utf8ToBytes(request.case.arguments.token))).slice(0, 12);
const target = process.env.RUSH_RESULT;
fs.writeFileSync(`${target}.tmp`, JSON.stringify({ protocol: "rush.harness.v1", status: "answered", answer: { digest } }));
fs.renameSync(`${target}.tmp`, target);
