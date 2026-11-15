export const recordPath = /^(profiles\/(?:profil-[^/]+|[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})\.json|devices\/[^/]+\.json|measures\/[^/]+\/[^/]+\.json)$/u;

export function snapshotPath(path) {
  if (typeof path !== 'string' || path.split('/').some(part =>
    !part || /^(?:\.|(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$))|[. ]$|[\\:*?"<>|\p{Cc}]/iu.test(part))) {
    return false;
  }
  return recordPath.test(path) || /^(?:(?:interface|session)\.json|transactions\.index|prefs\/(?:global|profil[-~][^/]+|(?:measurements|measurement-details)\/[^/]+)\.json|notifications\/[^/]+\.json|transactions(?:\.incoming)?\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{6}Z-[0-9a-f-]{36}\.json)$/u.test(path);
}

export function fileRecords(files) {
  const archive = { profiles: [], devices: [], measurements: [] };
  for (const { path, contents } of files) {
    if (!recordPath.test(path)) continue;
    try {
      const row = JSON.parse(contents.replace(/^\uFEFF/u, ''));
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Objet JSON attendu.');
      if (path.startsWith('profiles/')) {
        if (!row.name && path.startsWith('profiles/profil-')) {
          const stem = path.slice('profiles/profil-'.length, -5);
          row.name = stem[0].toLocaleUpperCase('fr') + stem.slice(1);
        }
        if (!row.uuid && !path.startsWith('profiles/profil-')) row.uuid = path.slice('profiles/'.length, -5);
        archive.profiles.push(row);
      } else if (path.startsWith('devices/')) {
        const stem = path.slice('devices/'.length, -5);
        if (!row.uuid && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(stem)) row.uuid = stem;
        archive.devices.push(row);
      } else {
        archive.measurements.push(row);
      }
    } catch (error) {
      throw new Error(path + ' · ' + error.message);
    }
  }
  return archive;
}
