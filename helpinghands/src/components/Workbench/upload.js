/**
 * What was dropped on the explorer from this computer, or picked in its file
 * dialog, as `{folders, files}`: the folders to make and `[path, File]` pairs,
 * paths relative to where it lands, a dropped folder with everything in it.
 */

/** The entries of a drop. Read at once: a drop's items are gone once its event returns. */
export function droppedEntries(dataTransfer) {
  return [...dataTransfer.items]
    .filter(item => item.kind === 'file')
    .map(item => item.webkitGetAsEntry?.() ?? item.getAsFile())
    .filter(Boolean);
}

const fileOf = entry => new Promise((resolve, reject) => entry.file(resolve, reject));

// A folder reader hands back its entries a batch at a time, then an empty batch.
async function childrenOf(entry) {
  const reader = entry.createReader();
  const children = [];
  for (;;) {
    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return children;
    children.push(...batch);
  }
}

/** `entries` from droppedEntries, or Files from a file input, read through. */
export async function uploadsOf(entries) {
  const folders = [];
  const files = [];
  const walk = async (entry, prefix) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry instanceof File) files.push([path, entry]);
    else if (entry.isFile) files.push([path, await fileOf(entry)]);
    else if (entry.isDirectory) {
      folders.push(path);
      for (const child of await childrenOf(entry)) await walk(child, path);
    }
  };
  for (const entry of entries) await walk(entry, '');
  return {folders, files};
}
