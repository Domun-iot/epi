// User-facing summary of the integrated broadcast formats in docs/BALANCES-BLE.md.
export const scaleFamilies = [
  ['Xiaomi · Mi Body Composition Scale', 'XMTZC02HM, XMTZC05HM'],
  ['Xiaomi · Mi Smart Scale', 'XMTZC01HM, XMTZC04HM'],
  ['Qingniu / QN AABB', 'FITINDEX FT-26R / FT-26R-W, RENPHO ES-CS20M / Elis 1, ES-24M-B, ES-26M-W'],
  ['Yunmai X', 'YMBS-M268, Mini 2S M1827CH (M1501)'],
  ['PICOOC Mini Lite', 'PICOOC-L'],
  ['Etekcity Fit 8S', 'Fit 8S'],
  ['Scale Up', 'BLE “da”'],
  ['Fitdays / ICOMON AAA', 'Silvergear Smart Scale 108, INSMART AAA006, Foryond FG263LB (AAA002), beatXP SMARTPLUS BXPBMI1004 (AAA041), AAA007, AAA013, Posture FG220LB (AAA07A)'],
  ['Senssun IF_B7', 'Grifema GA2001'],
  ['OKOK / Chipsea', 'C0 (Yoda0 / Yoda1), Fitelo FIT PRO 2025-1 (tzc), V11, V20 (ADV)'],
  ['Eufy', 'C1 (T9146), P1 (T9147), P2 (T9148), P2 Pro (T9149), C20 (T9130), P3 (T9150)'],
  ['AiLink / eLink EL1', 'AiLink Body Fat EL1 (CID/VID/PID 01/03/01)'],
];

// Same sources as the implementation notes in cli/README.md.
export const calculationMethods = [
  [0, ['Mi Fit', 'https://github.com/lolouk44/xiaomi_mi_scale/blob/master/src/Xiaomi_Scale_Body_Metrics.py']],
  [1, ['Sun et al. (2003)*', 'https://pubmed.ncbi.nlm.nih.gov/12540391/']],
  [2, ['Janssen et al. (2000)*', 'https://pubmed.ncbi.nlm.nih.gov/10926627/']],
  [3, ['Deurenberg et al. (1990)*', 'https://www.inner-image.com/assets/2015/05/4.-Deurenberg-van-der-Kooij-Evers-Hulshof-1990.pdf']],
  [4, ['Deurenberg et al. (1991)', 'https://pubmed.ncbi.nlm.nih.gov/2043597/']],
  [4, ['Gómez-Ambrosi et al. (2012) · CUN-BAE', 'https://pubmed.ncbi.nlm.nih.gov/22179957/']],
  [5, ['Watson et al. (1980)', 'https://doi.org/10.1093/ajcn/33.1.27']],
  [5, ['Hume & Weyers (1971)', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC476961/']],
  [6, ['Mifflin–St Jeor et al. (1990)', 'https://doi.org/10.1093/ajcn/51.2.241']],
  [6, ['Roza & Shizgal (1984) · Harris–Benedict', 'https://pubmed.ncbi.nlm.nih.gov/6741850/']],
  [6, ['Owen et al. (1986)', 'https://pubmed.ncbi.nlm.nih.gov/3728346/'],
    ['Owen et al. (1987)', 'https://pubmed.ncbi.nlm.nih.gov/3687821/']],
  [6, ['Cunningham (1980)*', 'https://pubmed.ncbi.nlm.nih.gov/7435418/']],
];
