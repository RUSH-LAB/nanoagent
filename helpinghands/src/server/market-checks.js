'use strict';

/**
 * Whether RUSH's NanoAgent still accepts an upload's package (postgres/market.js). Each was
 * checked by the NanoAgent it was published on, against the rules of the spec its plugin
 * declares, which never change; a newer NanoAgent refuses it only when it does not run that spec,
 * as 0.7.0 refuses a package made before plugins declared one: that version is `refused`, with
 * `refusal` saying why, until its uploader publishes it again. NanoAgent keeps
 * how it checked each package while it runs, so a package is sent to it once.
 */
async function checkUpload({ai, market}, userId, entry) {
  let checked = await ai.inspection(entry.sha256);
  if (checked.status === 404) {
    const data = (await market.get(userId, entry.id, entry.version))?.package;
    if (!data) return {error: `${entry.id} ${entry.version} is no longer in the marketplace`, status: 404};
    checked = await ai.inspect(data);
  }
  if (checked.status === 422) return {value: {...entry, status: 'refused', refusal: checked.error}};
  return checked.error ? checked : {value: entry};
}

/** Every upload at its latest version, each as checkUpload has it: `{value}` or `{error, status}`. */
async function checkedUploads(deps, userId) {
  const checked = await Promise.all((await deps.market.list(userId)).map(entry => checkUpload(deps, userId, entry)));
  return checked.find(result => result.error) ?? {value: checked.map(result => result.value)};
}

module.exports = {checkUpload, checkedUploads};
