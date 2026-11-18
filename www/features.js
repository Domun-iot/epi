import { featureCopy } from './features-copy.js';
import { calculationMethods, scaleFamilies } from './feature-catalog.js';

const compatibilityAnchor = '#bluetooth';
const paths = { bluetooth: '/compatible-scales', multiscale: compatibilityAnchor, composition: '/calculation-methods', source: '/developers' };
const sourceLines = ['éPI/', '├─ shared/scales/', '├─ tauri/', '├─ cli/', '├─ web/', '└─ docs/'];
const scale = (lang, weight) => '<div class="scale"><samp>' +
  new Intl.NumberFormat(lang).format(weight) + ' kg</samp><i></i><i></i></div>';
const pictures = {
  bluetooth: (t, base, escape, lang) => scale(lang, 72.4) +
    '<div class="signal"><i></i><i></i><i></i><span class="signal-packet"></span></div><span class="received">✓</span>',
  profiles: t => '<ul class="profile-cards">' + t.profiles.map(name =>
    '<li><span class="avatar">' + name[0] + '</span>' + name + '</li>').join('') + '</ul>',
  multiscale: (t, base, escape, lang) => scale(lang, 72.4) + scale(lang, 72.6),
  composition: () => '<ul class="formula-bars"><li>Mi Fit <i></i><samp>24.1%</samp></li>' +
    '<li>Deurenberg <i></i><samp>22.6%</samp></li><li>CUN-BAE <i></i><samp>25.3%</samp></li></ul>',
  views: (t, base, escape) => '<div class="view-shots"><img class="chart" src="' + base +
    '/assets/chart.jpg" alt="' + escape(t.chartScreenshot) + '" width="824" height="1784" loading="lazy">' +
    '<img class="chart" src="' + base + '/assets/weigh-ins.jpg" alt="' + escape(t.screenshot) +
    '" width="824" height="1784" loading="lazy"></div>',
  sync: t => '<div class="sync-map"><div class="sync-hub">éPI</div><ul>' +
    [['pc', 'PC'], ['board', 'Linux'], ['phone', t.phone], ['browser', t.browser]].map(([icon, label]) =>
      '<li><span class="sync-packet"></span><span class="device"><i class="' + icon +
      '-icon"></i>' + label + '</span></li>').join('') + '</ul></div>',
  local: () => '<div class="archive-files"><span>JSON</span><span>JSON</span><span>JSON</span><strong>ZIP</strong></div>',
  source: () => '<pre class="code-sample"><code>' +
    sourceLines.map(line => '<span>' + line + '</span>').join('') + '</code></pre>',
};

export function renderFeature(base, id, title, description, { copy, lang }, escape, extra = '') {
  const decorative = id === 'views' ? '' : ' aria-hidden="true"';
  return '<section class="feature feature-' + id + '" id="' + id + '" aria-labelledby="' + id + '-title">' +
    '<div class="feature-copy"><h2 id="' + id + '-title">' + escape(title) + '</h2><p>' +
    escape(description) + '</p>' + extra + '</div>' +
    '<div class="feature-art"' + decorative + '>' + pictures[id](copy, base, escape, lang) + '</div></section>';
}

export function renderHome(base, intro, locale, escape) {
  const features = featureCopy(locale);
  const { copy, lang } = features;
  const scenes = Object.entries(copy.scenes).map(([id, [title, description, label]]) => {
    const path = paths[id];
    const linkLabel = label || (id === 'source' ? 'Open source / ' + (lang.startsWith('fr') ? 'Développeurs' : 'Developers') : '');
    const link = linkLabel ? '<a class="feature-link" href="' + (path.startsWith('#') ? path : base + path) + '">' +
      escape(linkLabel) + ' <span aria-hidden="true">→</span></a>' : '';
    const proDetail = copy.proDetails[id];
    const proNote = proDetail ? '<p class="feature-pro-note"><a class="pro-badge" href="' + base +
      '/pro#compare" aria-label="' + escape(copy.proComparison) + '">PRO <span aria-hidden="true">→</span></a> ' +
      escape(proDetail) + '</p>' : '';
    return renderFeature(base, id, title, description.replace('{count}', scaleFamilies.length),
      features, escape, link + proNote);
  }).join('');
  const scaleLink = '<sup><a class="scale-note" href="' + compatibilityAnchor + '" lang="' + lang +
    '" aria-label="' + escape(copy.scaleTitle) + '">*</a></sup>';
  return '<div class="hero"><div><h1>' + escape(intro.headline) + scaleLink + '</h1><p>' + intro.intro + '</p>' +
    '<div lang="' + lang + '"><p class="motto">' + escape(copy.motto) + '</p>' +
    '<a class="hero-link" href="' + compatibilityAnchor + '"><span class="hero-link-label">' + escape(copy.explore) + '</span><span aria-hidden="true">↓</span></a></div>' +
    '</div><img class="chart" src="' + base + '/assets/chart.jpg" alt="" width="824" height="1784"></div>' +
    '<div class="features" lang="' + lang + '">' + scenes + '</div>';
}

export function referenceTitle(page, locale) {
  const { copy } = featureCopy(locale);
  return page === 'scales' ? copy.scaleTitle : copy.methodTitle;
}

export function renderReference(base, page, locale, escape) {
  const { copy, lang } = featureCopy(locale);
  const paragraph = value => '<p>' + escape(value) + '</p>';
  const row = (name, description) => '<div><dt>' + name + '</dt><dd>' + escape(description) + '</dd></div>';
  const scales = () => paragraph(copy.scaleIntro) +
    '<h2>' + escape(copy.broadcast) + '</h2><dl class="reference-list">' +
    scaleFamilies.map(([family, models]) => row(escape(family), models)).join('') + '</dl>' +
    paragraph(copy.vf0) + '<h2>' + escape(copy.gatt) + '</h2>' + paragraph(copy.gattText);
  const methods = () => paragraph(copy.methodIntro) + '<dl class="reference-list">' +
    calculationMethods.map(([metric, ...sources]) => row(sources.map(([name, url]) =>
      '<a href="' + url + '">' + escape(name) + '</a>').join(' · '), copy.methods[metric])).join('') +
    '</dl>' + paragraph(copy.impedance);
  return '<div lang="' + lang + '"><h1>' +
    escape(referenceTitle(page, locale)) + '</h1>' + (page === 'scales' ? scales() : methods()) + '</div>';
}
