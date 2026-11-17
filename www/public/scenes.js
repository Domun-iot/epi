const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const duration = 1000;

function track(element, frames, from = 0, to = 1, easing = 'ease-out') {
  const animation = element.animate(frames, {
    delay: from * duration,
    duration: (to - from) * duration,
    easing,
    fill: 'both',
  });
  animation.pause();
  return animation;
}

const scenes = {
  bluetooth(art) {
    const scale = art.querySelector('.scale');
    const screen = scale.querySelector('samp');
    const waves = [...art.querySelectorAll('.signal i')];
    const packet = art.querySelector('.signal-packet');
    const receipt = art.querySelector('.received');
    const ready = screen.textContent;
    const unit = ready.slice(ready.indexOf(' '));
    const locale = art.closest('[lang]').lang;
    const format = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const readings = [69.8, 73.1, 72.8, 72.5].map(weight => format.format(weight) + unit);
    readings.push(ready);
    return {
      animations: [
        track(scale, [
          { translate: '0 -32px', rotate: '-12deg', scale: '.88' },
          { translate: '0 8px', rotate: '15deg', scale: '1.04 .93', offset: .42 },
          { translate: '0 -3px', rotate: '-4deg', scale: '.98 1.03', offset: .72 },
          { translate: 'none', rotate: 'none', scale: 'none' },
        ], 0, .41, 'linear'),
        track(screen, [{ opacity: .45 }, { opacity: 1, boxShadow: '0 0 18px #8fdcaf' }], 0, .41),
        ...waves.map((wave, i) => track(wave, [
          { opacity: 0, scale: '.4 .7' },
          { opacity: 1, scale: '1.24 1.15', offset: .45 },
          { opacity: .7, scale: '1' },
        ], .32 + i * .09, .60 + i * .09)),
        track(packet, [
          { opacity: 0, left: '0%' }, { opacity: 1, offset: .22 },
          { opacity: 1, offset: .8 }, { opacity: 0, left: '104%' },
        ], .43, .78, 'linear'),
        track(receipt, [
          { opacity: 0, scale: '.28', rotate: '-28deg' },
          { opacity: 1, scale: '1.22', rotate: '7deg', offset: .68 },
          { opacity: 1, scale: '1', rotate: 'none' },
        ], .7, .99),
      ],
      update(progress) {
        const value = readings[Math.min(readings.length - 1, Math.floor(progress * readings.length / .45))];
        if (screen.textContent !== value) screen.textContent = value;
      },
    };
  },

  profiles(art) {
    return {
      animations: [...art.querySelectorAll('.profile-cards li')].map((card, i) =>
        track(card, [
          { opacity: 0, translate: (i % 2 ? '-' : '') + '46px 26px', rotate: i % 2 ? '-8deg' : '8deg', scale: '.88' },
          { opacity: 1, translate: '0 -4px', rotate: '0deg', scale: '1.03', offset: .72 },
          { opacity: 1, translate: 'none', rotate: 'none', scale: 'none' },
        ], .08 + i * .17, .57 + i * .17)),
    };
  },

  multiscale(art) {
    return {
      animations: [...art.querySelectorAll('.scale')].map((scale, i) =>
        track(scale, [
          { opacity: .3, translate: (i ? '30px' : '-30px') + ' 12px' },
          { opacity: 1, translate: 'none' },
        ], .08 + i * .18, .63 + i * .18)),
    };
  },

  composition(art) {
    const rows = [...art.querySelectorAll('.formula-bars li')];
    return {
      animations: rows.flatMap((row, i) => [
        track(row.querySelector('i'), [{ scale: '0 1' }, { scale: '1 1' }], .1 + i * .17, .55 + i * .17),
        track(row.querySelector('samp'), [
          { opacity: 0, translate: '-.5rem 0' }, { opacity: 1, translate: 'none' },
        ], .33 + i * .17, .63 + i * .17),
      ]),
    };
  },

  views(art) {
    const [chart, table] = art.querySelectorAll('img');
    return {
      animations: [
        track(chart, [
          { opacity: .82, translate: '42% 16px', rotate: '0deg', scale: '1.02' },
          { opacity: 1, translate: '0 0', rotate: '-8deg', scale: '1' },
        ], .06, .9),
        track(table, [
          { opacity: 0, translate: '-45% 56px', rotate: '-8deg', scale: '.85' },
          { opacity: 1, translate: '0 0', rotate: '8deg', scale: '1' },
        ], .22, .96),
      ],
    };
  },

  sync(art) {
    const devices = [...art.querySelectorAll('.sync-map li')];
    return {
      animations: [
        track(art.querySelector('.sync-hub'), [
          { scale: '.76', boxShadow: '0 0 0 0 #508bad70' },
          { scale: '1.12', boxShadow: '0 0 0 14px #508bad10', offset: .54 },
          { scale: '1', boxShadow: '0 0 0 0 #508bad00' },
        ], .08, .63),
        ...devices.flatMap((device, i) => [
          track(device.querySelector('.sync-packet'), [
            { opacity: 0, translate: '0 -1.2rem' }, { opacity: 1, offset: .18 },
            { opacity: 1, offset: .75 }, { opacity: 0, translate: '0 2.1rem' },
          ], .3 + i * .09, .64 + i * .09, 'linear'),
          track(device.querySelector('.device'), [
            { opacity: .38, scale: '.83' },
            { opacity: 1, scale: '1.11', background: '#fff', offset: .68 },
            { opacity: 1, scale: '1', background: '#f8fbfd' },
          ], .36 + i * .09, .71 + i * .09),
        ]),
      ],
    };
  },

  local(art) {
    const files = [...art.querySelectorAll('.archive-files span')];
    return {
      animations: [
        ...files.map((file, i) => track(file, [
          { opacity: 0, translate: (i - 1) * 32 + 'px -74px', rotate: (i - 1) * 12 + 'deg' },
          { opacity: 1, translate: (i - 1) * 14 + 'px -17px', rotate: '0deg', offset: .65 },
          { opacity: 1, translate: 'none', rotate: 'none' },
        ], .05 + i * .12, .63 + i * .12)),
        track(art.querySelector('.archive-files strong'), [
          { opacity: .4, translate: '0 27px', scale: '.8' },
          { opacity: 1, translate: '0 -3px', scale: '1.06', offset: .72 },
          { opacity: 1, translate: 'none', scale: 'none' },
        ], .34, .92),
      ],
    };
  },

  source(art) {
    return {
      animations: [...art.querySelectorAll('.code-sample span')].map((line, i) =>
        track(line, [{ opacity: 0, translate: '-.75rem 0' }, { opacity: 1, translate: 'none' }],
          .06 + i * .105, .36 + i * .105)),
    };
  },
};

let activeScenes = [];
let pendingFrame = 0;

function draw() {
  pendingFrame = 0;
  const viewport = document.documentElement.clientHeight;
  const positions = activeScenes.map(({ art }) => art.getBoundingClientRect());
  activeScenes.forEach((scene, i) => {
    const { top, height } = positions[i];
    const start = viewport * .9 - Math.min(height * .45, viewport * .22);
    const distance = Math.min(viewport * .58, viewport * .3 + height * .36);
    const progress = Math.max(0, Math.min(1, (start - top) / distance));
    if (progress === scene.progress) return;
    scene.progress = progress;
    for (const animation of scene.animations) animation.currentTime = progress * duration;
    scene.update?.(progress);
  });
}

function scheduleDraw() {
  if (!pendingFrame) pendingFrame = requestAnimationFrame(draw);
}

function setMotion() {
  if (reducedMotion.matches) {
    removeEventListener('scroll', scheduleDraw);
    removeEventListener('resize', scheduleDraw);
    removeEventListener('load', scheduleDraw);
    for (const { animations, update } of activeScenes) {
      for (const animation of animations) animation.cancel();
      update?.(1);
    }
    activeScenes = [];
    cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
    return;
  }
  activeScenes = [...document.querySelectorAll('.feature')].map(section => {
    const art = section.querySelector('.feature-art');
    return { art, ...scenes[section.id](art) };
  });
  addEventListener('scroll', scheduleDraw, { passive: true });
  addEventListener('resize', scheduleDraw);
  addEventListener('load', scheduleDraw, { once: true });
  draw();
}

if (typeof Element.prototype.animate === 'function') {
  reducedMotion.addEventListener('change', setMotion);
  setMotion();
}
