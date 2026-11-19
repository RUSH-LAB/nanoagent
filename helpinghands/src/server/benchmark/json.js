'use strict';

const {LosslessNumber, parse, stringify} = require('lossless-json');

const SAFE_INTEGER = /^-?(?:0|[1-9]\d*)$/;

/**
 * A JSON number as a JavaScript number if it is a safe integer, else a LosslessNumber keeping its spelling: `1.0`,
 * `1e-05`, `0.1` and `12345678901234567890` are what Python's `json.dumps` wrote, and are what Python prints again.
 */
const readNumber = lexeme => (SAFE_INTEGER.test(lexeme) && Number.isSafeInteger(Number(lexeme)) ? Number(lexeme) : new LosslessNumber(lexeme));

/** `text` as JSON, every number that JavaScript would not print back as it was written kept as a LosslessNumber. */
const parseJson = text => parse(text, undefined, readNumber);

/** `value` as JSON text, every LosslessNumber written as the characters it was read from; wherever a parsed value is written back, this and not JSON.stringify. */
const stringifyJson = value => stringify(value);

const isLosslessNumber = value => value instanceof LosslessNumber;

module.exports = {parseJson, stringifyJson, isLosslessNumber};
