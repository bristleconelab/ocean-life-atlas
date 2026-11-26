// Interface language: English or Uzbek (Latin). Each text sits where it is used as a pair, L('English', 'Oʻzbekcha'),
// so the two never drift apart. The choice is kept in localStorage; the first visit follows the browser.
import type { GroupId } from './taxa';

export type Lang = 'en' | 'uz';

function pick(): Lang {
  try {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('lang') : null;
    if (saved === 'en' || saved === 'uz') return saved;
  } catch { /* storage blocked: fall through */ }
  const nav = typeof navigator !== 'undefined' ? navigator.language.toLowerCase() : 'en';
  return nav.startsWith('uz') ? 'uz' : 'en';
}

export const lang: Lang = pick();
export const L = (en: string, uz: string): string => (lang === 'uz' ? uz : en);

export function setLang(l: Lang) {
  try { localStorage.setItem('lang', l); } catch { /* ignore */ }
  location.reload();
}

const fmtN = (n: number) => n.toLocaleString('en-US');
/** "3 species" / "3 ta tur": Uzbek nouns stay singular after a number. */
export const count = (n: number, en: string, enMany: string, uz: string) => L(`${fmtN(n)} ${n === 1 ? en : enMany}`, `${fmtN(n)} ta ${uz}`);

const GROUP_UZ: Record<GroupId, string> = {
  fish: 'Baliqlar', sharks: 'Akulalar va skatlar', turtles: 'Dengiz toshbaqalari va boshqa sudralib yuruvchilar',
  mammals: 'Dengiz sutemizuvchilari', birds: 'Dengiz va qirgʻoq qushlari', corals: 'Marjonlar, aktiniyalar va meduzalar',
  molluscs: 'Chigʻanoqlar, kalmarlar va sakkizoyoqlar', crustaceans: 'Qisqichbaqalar, krevetkalar va krill',
  echinoderms: 'Dengiz yulduzlari va tipratikanlari', algae: 'Suvoʻtlari va dengiz oʻtlari', plankton: 'Plankton va bir hujayralilar',
  other: 'Gubkalar, chuvalchanglar va boshqalar',
};
export const groupLabelUz = (g: GroupId) => GROUP_UZ[g];

export const IUCN_UZ: Record<string, string> = {
  EX: 'Yoʻq boʻlib ketgan', EW: 'Tabiatda yoʻq boʻlib ketgan', CR: 'Yoʻqolish arafasida', EN: 'Yoʻqolib borayotgan',
  VU: 'Zaif', NT: 'Xavf ostiga yaqin', LC: 'Xavf ostida emas', DD: 'Maʼlumot yetarli emas',
};

export const BANDS_UZ = ['Sirt, 0–10 m', '10–50 m', '50–200 m, yorugʻ dengiz', '200–1 000 m, gʻira-shira zona', '1–4 km, yarim tun zonasi', '4 km dan pastda, tubsizlik'];
export const MONTHS_UZ = ['Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun', 'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'];
