import { featureCopy } from './features-copy.js';
import { calculationMethods, scaleFamilies } from './feature-catalog.js';

const paths = { bluetooth: '/compatible-scales', composition: '/calculation-methods' };
const sourceLines = ['éPI/', '├─ shared/scales/', '├─ tauri/', '├─ cli/', '├─ web/', '└─ docs/'];
const pictures = {
  bluetooth: (t, base, escape, lang) => '<div class="scale"><samp>' +
    new Intl.NumberFormat(lang).format(72.4) + ' kg</samp><i></i><i></i></div>' +
    '<div class="signal"><i></i><i></i><i></i><span class="signal-packet"></span></div><span class="received">✓</span>',
  profiles: t => '<ul class="profile-cards">' + t.profiles.map(name =>
    '<li><span class="avatar">' + name[0] + '</span>' + name + '</li>').join('') + '</ul>',
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

export function renderHome(base, intro, locale, escape) {
  const { copy, lang } = featureCopy(locale);
  const scenes = Object.entries(copy.scenes).map(([id, [title, description, label]]) => {
    const link = label ? '<a class="feature-link" href="' + base + paths[id] + '">' +
      escape(label) + ' <span aria-hidden="true">→</span></a>' : '';
    const decorative = id === 'views' ? '' : ' aria-hidden="true"';
    return '<section class="feature feature-' + id + '" id="' + id + '" aria-labelledby="' + id + '-title">' +
      '<div class="feature-copy"><h2 id="' + id + '-title">' + escape(title) + '</h2><p>' +
      escape(description.replace('{count}', scaleFamilies.length)) + '</p>' + link + '</div>' +
      '<div class="feature-art"' + decorative + '>' + pictures[id](copy, base, escape, lang) + '</div></section>';
  }).join('');
  return '<div class="hero"><div><h1>' + intro.headline + '</h1><p>' + intro.intro + '</p>' +
    '<div lang="' + lang + '"><p class="motto">' + escape(copy.motto) + '</p>' +
    '<a class="hero-link" href="#bluetooth"><span class="hero-link-label">' + escape(copy.explore) + '</span><span aria-hidden="true">↓</span></a></div>' +
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
  const anchor = page === 'scales' ? 'bluetooth' : 'composition';
  return '<div lang="' + lang + '"><a class="back-link" href="' + base + '#' + anchor +
    '"><span aria-hidden="true">← </span>' + escape(copy.back) + '</a><h1>' +
    escape(referenceTitle(page, locale)) + '</h1>' + (page === 'scales' ? scales() : methods()) + '</div>';
}
