/**
 * Human-friendly claim codes for instance setup
 */

import { randomInt } from 'node:crypto';

const ADJECTIVES = [
  'BARIG',
  'BRAV',
  'DAMISCH',
  'DEFTIG',
  'DUNKEL',
  'FESCH',
  'FIDEL',
  'FLOTT',
  'FUCHSIG',
  'GACH',
  'GFINKELT',
  'GFREIT',
  'GLUADIG',
  'GMIATLICH',
  'GRANTIG',
  'GRIABIG',
  'GSCHAFTIG',
  'GSCHEIT',
  'GSCHMACKIG',
  'GSPASSIG',
  'GSUND',
  'HELL',
  'HOAGLIG',
  'HOAMELIG',
  'KERNIG',
  'KLOA',
  'KOMMOD',
  'LUSTIG',
  'MUNTER',
  'NARRISCH',
  'NOBEL',
  'PFUNDIG',
  'RASSIG',
  'RESCH',
  'SAKRISCH',
  'SAUBER',
  'SCHEE',
  'SCHNEIDIG',
  'STAAD',
  'SUFFIG',
  'WEISSBLAU',
  'WUID',
  'ZACKIG',
  'ZUENFTIG',
  'ZWIDER',
];

const NOUNS = [
  'ALM',
  'ALMHUETTE',
  'AUSZOGNE',
  'BERGSEE',
  'BIERGARTN',
  'BREZN',
  'BUSSERL',
  'DACKEL',
  'DAMPFNUDEL',
  'DIRNDL',
  'EDELWEISS',
  'ENZIAN',
  'GAMS',
  'GAMSBART',
  'GAUDI',
  'GOCKL',
  'HAFERL',
  'HAXN',
  'HENDL',
  'JANKER',
  'KACHELOFEN',
  'KEFERLOHER',
  'KIRTA',
  'KNOEDL',
  'KRAMPUS',
  'KREN',
  'KUHGLOCKN',
  'LEBERKAS',
  'LEDERHOSN',
  'MAIBAAM',
  'MASSKRUG',
  'MURMELTIER',
  'OBATZDA',
  'RADI',
  'RADLER',
  'SCHAFKOPF',
  'SCHMANKERL',
  'SEMMEL',
  'STAMMTISCH',
  'STRUDL',
  'WATTN',
  'WEISSBIER',
  'WIESN',
  'WIRTSHAUS',
  'WOLPERTINGER',
  'ZWETSCHGN',
];

export function mintClaimCode(): string {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  const digits = String(randomInt(1000, 10000));
  return `${adjective}-${noun}-${digits}`;
}

export function normalizeClaimCode(raw: string): string | null {
  const code = raw.trim().toUpperCase().replace(/\s+/g, '');
  return CODE_SHAPE.test(code) ? code : null;
}

/** Matches ADJECTIVE-NOUN-4digits after normalisation */
export const CODE_SHAPE = /^[A-Z]{3,12}-[A-Z]{3,12}-[0-9]{4}$/;
