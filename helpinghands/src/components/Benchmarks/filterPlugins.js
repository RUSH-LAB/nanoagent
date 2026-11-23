/** The plugins whose name, id or description contains `query`, ignoring case; all of them for a blank query. */
export function filterPlugins(apps, query) {
  const needle = query.trim().toLowerCase();
  return apps.filter(app => [app.name, app.id, app.product?.tagline, app.product?.description]
    .some(text => typeof text === 'string' && text.toLowerCase().includes(needle)));
}
