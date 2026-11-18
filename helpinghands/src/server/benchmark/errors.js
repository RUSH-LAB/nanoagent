'use strict';

/** A refusal the API answers with `status`, its `code`, and the `extra` fields beside them. */
class BenchmarkError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'BenchmarkError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

module.exports = {BenchmarkError};
