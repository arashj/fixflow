import { Category, Urgency } from '../../common/types';

/**
 * Keyword rules used by the local rules engine (no API key). Phrases score higher than single words.
 * Pest words are weighted up: "mice near the stove" is a pest problem, not an appliance problem.
 */
const WEIGHT: Partial<Record<Category, number>> = { PEST: 3 };
const CATEGORY_RULES: Record<Category, string[]> = {
  PLUMBING: ['water heater', 'hot water', 'leak', 'leaking', 'leaks', 'drip', 'dripping', 'pipe', 'pipes', 'faucet', 'tap', 'sink', 'toilet',
    'clog', 'clogged', 'drain', 'shower', 'bathtub', 'tub', 'sewage', 'plumbing', 'flush', 'flood', 'flooding'],
  ELECTRICAL: ['outlet', 'outlets', 'socket', 'breaker', 'power', 'light', 'lights', 'switch', 'spark', 'sparking', 'sparks', 'wiring',
    'electrical', 'fuse', 'smoke detector', 'smoke alarm', 'flickering', 'electric'],
  HVAC: ['heat', 'heating', 'radiator', 'boiler', 'furnace', 'air conditioning', 'air conditioner', 'thermostat', 'ventilation', 'vent',
    'cold apartment', 'no heat', 'ac'],
  APPLIANCE: ['fridge', 'refrigerator', 'freezer', 'stove', 'oven', 'dishwasher', 'washer', 'washing machine', 'dryer', 'microwave',
    'range hood', 'cooktop', 'burner'],
  STRUCTURAL: ['crack', 'cracked', 'ceiling', 'wall', 'walls', 'floor', 'paint', 'scuff', 'scuffs', 'baseboard', 'door', 'window', 'roof', 'stairs', 'railing', 'lock', 'tile', 'drywall'],
  PEST: ['mice', 'mouse', 'rat', 'rats', 'cockroach', 'cockroaches', 'roach', 'roaches', 'bugs', 'bedbug', 'bedbugs', 'ants', 'pest', 'pests',
    'wasp', 'wasps', 'droppings', 'termites', 'infestation'],
  GENERAL: [],
};

const EMERGENCY = ['gas', 'smell gas', 'gas smell', 'smoke', 'fire', 'sparking', 'sparks', 'burning smell', 'flood', 'flooding', 'burst',
  'sewage', 'carbon monoxide', 'pouring', 'gushing', 'collapsed', 'no heat', 'electric shock', 'shocked'];
const HIGH = ['leak', 'leaking', 'no hot water', 'not working', "doesn't work", 'does not work', 'broken lock', "can't lock", 'cannot lock',
  'no power', 'clogged', 'overflowing', 'mold', 'mice', 'cockroaches', 'roaches', 'bedbugs', 'not cooling', 'stopped cooling', 'no longer cooling', 'stopped working', 'dead'];
const LOW = ['cosmetic', 'paint', 'scuff', 'squeak', 'squeaky', 'loose', 'minor', 'small', 'slowly', 'slow drain', 'when you have time', 'not urgent'];

export function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').replace(/\s+/g, ' ')} `;
}

function hits(text: string, phrase: string): boolean {
  return text.includes(` ${phrase} `);
}

export function classifyCategory(raw: string): Category {
  const text = normalize(raw);
  let best: Category = 'GENERAL';
  let bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORY_RULES) as [Category, string[]][]) {
    let score = 0;
    for (const w of words) if (hits(text, w)) score += (w.includes(' ') ? 3 : 1) * (WEIGHT[cat] ?? 1);
    // "water heater" is plumbing, not heating
    if (cat === 'HVAC' && hits(text, 'water heater')) score -= 2;
    if (score > bestScore) {
      best = cat;
      bestScore = score;
    }
  }
  return best;
}

export function classifyUrgency(raw: string, category: Category, now = new Date()): { urgency: Urgency; reason: string } {
  const text = normalize(raw);
  const find = (list: string[]) => list.find((w) => hits(text, w));
  const winter = [10, 11, 12, 1, 2, 3, 4].includes(now.getMonth() + 1);
  const heatOut = category === 'HVAC' && (hits(text, 'no heat') || hits(text, 'heat not working') || hits(text, 'heating not working')
    || hits(text, 'heating stopped') || hits(text, 'radiator cold') || hits(text, 'radiators cold') || hits(text, 'freezing'));
  if (heatOut) return winter ? { urgency: 'EMERGENCY', reason: 'no heat during the cold season' } : { urgency: 'HIGH', reason: 'heating is out' };
  const e = find(EMERGENCY.filter((w) => w !== 'no heat'));
  if (e && !(e === 'smoke' && (hits(text, 'smoke detector') || hits(text, 'smoke alarm')) && !hits(text, 'fire'))) {
    return { urgency: 'EMERGENCY', reason: `mentions "${e}"` };
  }
  const l = find(LOW);
  const h = find(HIGH);
  if (h) {
    const minorLeak = (h === 'leak' || h === 'leaking') && l && ['slowly', 'slow drain', 'small', 'minor'].includes(l);
    return minorLeak ? { urgency: 'NORMAL', reason: `a ${l} ${h}` } : { urgency: 'HIGH', reason: `mentions "${h}"` };
  }
  if (l) return { urgency: 'LOW', reason: `mentions "${l}"` };
  return { urgency: 'NORMAL', reason: 'no urgency signals' };
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'it', 'in', 'on', 'of', 'to', 'my', 'i', 'there', 'this', 'that',
  'with', 'for', 'from', 'at', 'be', 'been', 'has', 'have', 'its', "it's", 'again', 'not', 'very', 'some', 'since', 'under', 'me', 'we', 'our']);

export function tokens(raw: string): Set<string> {
  return new Set(normalize(raw).trim().split(' ').filter((t) => t.length > 2 && !STOP.has(t)).map((t) => t.replace(/s$/, '')));
}

export function similarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

const SYNONYMS: Record<string, string[]> = {
  refrigerator: ['fridge', 'freezer'], stove: ['oven', 'burner', 'cooktop', 'range'], toilet: ['flush'], 'water heater': ['hot water'],
  boiler: ['heat', 'heating', 'radiator', 'radiators'], 'electrical panel': ['breaker', 'fuse', 'power'], 'smoke detector': ['smoke alarm', 'alarm', 'beeping'],
  'kitchen sink': ['sink', 'faucet', 'tap'], 'bathroom sink': ['sink', 'faucet', 'tap', 'vanity'], dishwasher: ['dish'],
  'front entrance door': ['entrance', 'front door', 'lobby door'],
};

const LOCATION_WORDS = new Set(['kitchen', 'bathroom', 'hallway', 'bedroom', 'front', 'entrance', 'rooftop', 'basement', 'unit']);
/** Words too common to identify equipment by themselves ("water" is in most plumbing reports, not just the water heater). */
const GENERIC_WORDS = new Set(['water', 'unit', 'main', 'door', 'panel']);

/**
 * Picks the asset the text is about: its name, a distinctive word of its name, or a synonym must appear.
 * Room words ("kitchen") alone don't count, and the asset must be in the request's category.
 */
export function matchAsset<T extends { id: string; name: string; category: string; unit_id?: string | null }>(raw: string, assets: T[], category: Category): T | undefined {
  const text = normalize(raw);
  let best: T | undefined;
  let bestScore = 0;
  for (const a of assets) {
    if (a.category !== category) continue;
    const name = a.name.toLowerCase();
    let score = 0;
    if (hits(text, name)) score += 5;
    for (const part of name.split(' ')) if (part.length > 3 && !LOCATION_WORDS.has(part) && !GENERIC_WORDS.has(part) && (hits(text, part) || hits(text, part + 's'))) score += 3;
    for (const syn of SYNONYMS[name] ?? []) if (hits(text, syn)) score += 2;
    // "bathroom faucet" must not match the "Kitchen sink": penalize a room in the name that contradicts the text
    const rooms = name.split(' ').filter((w) => LOCATION_WORDS.has(w));
    const textRooms = [...LOCATION_WORDS].filter((w) => hits(text, w));
    if (rooms.length && textRooms.length && !rooms.some((r) => textRooms.includes(r))) score -= 4;
    if (score > 0 && a.unit_id) score += 0.5;
    if (score > bestScore) {
      best = a;
      bestScore = score;
    }
  }
  return bestScore >= 2 ? best : undefined;
}

export function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}
