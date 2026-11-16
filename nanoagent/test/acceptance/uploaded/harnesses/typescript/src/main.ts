// A harness with zero model calls: computes the probe's digest locally and writes the result atomically.
import { createHash } from "node:crypto";
import * as fs from "node:fs";

interface Request {
  case: { arguments: { token: string } };
}

const request = JSON.parse(fs.readFileSync(process.env.RUSH_REQUEST as string, "utf8")) as Request;
const digest = createHash("sha256").update(request.case.arguments.token).digest("hex").slice(0, 12);
const target = process.env.RUSH_RESULT as string;
fs.writeFileSync(`${target}.tmp`, JSON.stringify({ protocol: "rush.harness.v1", status: "answered", answer: { digest } }));
fs.renameSync(`${target}.tmp`, target);
