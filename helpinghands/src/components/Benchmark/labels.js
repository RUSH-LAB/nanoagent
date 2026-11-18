/** Wording shared by the benchmark screens. */

/** `1 case`, `2 cases`. */
export const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** A harness as `name v1`, from anything with a `name` and a `version`. */
export const harnessLabel = harness => `${harness.name} v${harness.version}`;
