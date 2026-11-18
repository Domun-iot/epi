export const logoNames = ['android', 'windows', 'linux', 'debian', 'ubuntu', 'mint', 'chrome', 'firefox', 'safari', 'edge', 'opera', 'opensource', 'browser', 'download', 'terminal', 'server', 'code', 'archive', 'github'];
export function logo(name, extra = '') {
  const labels = { android: 'Android', windows: 'Windows', linux: 'Linux', debian: 'Debian', ubuntu: 'Ubuntu', mint: 'Linux Mint', chrome: 'Google Chrome', firefox: 'Firefox', safari: 'Safari', edge: 'Microsoft Edge', opera: 'Opera', opensource: 'Open source', github: 'GitHub' };
  return '<img class="platform-logo ' + extra + '" src="/epi/assets/logos/' + name + '.svg" alt="' + (labels[name] || '') + '" width="48" height="48">';
}
export function browserLogo(userAgent = '') {
  if (/Edg(?:e|A|iOS)?\//i.test(userAgent)) return 'edge';
  if (/OPR\/|Opera|OPiOS\//i.test(userAgent)) return 'opera';
  if (/Firefox\/|FxiOS\//i.test(userAgent)) return 'firefox';
  if (/Chrome\/|CriOS\//i.test(userAgent)) return 'chrome';
  if (/Safari\//i.test(userAgent)) return 'safari';
  return 'browser';
}
export function developerTile(locale) {
  const fr = locale.startsWith('fr');
  return '<a class="developer-tile" href="/epi/developers">' + logo('opensource') +
    '<span><strong>Open source / ' + (fr ? 'Développeurs' : 'Developers') + '</strong><span>' +
    (fr ? 'Sources, tous les formats et documentation technique.' : 'Source code, every format and technical documentation.') +
    '</span></span><span class="tile-arrow" aria-hidden="true">→</span></a>';
}
