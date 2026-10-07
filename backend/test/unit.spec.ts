import { classifyCategory, classifyUrgency, matchAsset, similarity } from '../src/agent/llm/classifier';
import { TOOL_DEFS, toolsForRun, validateInput } from '../src/agent/tools';

describe('rules-engine classifier', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');
  it.each([
    ['Mice near the stove, droppings in the cabinet', 'PEST', 'HIGH'],
    ['Water pouring from under the kitchen sink', 'PLUMBING', 'EMERGENCY'],
    ['Fridge stopped cooling', 'APPLIANCE', 'HIGH'],
    ['No hot water since this morning', 'PLUMBING', 'HIGH'],
    ['I smell gas near the stove', 'APPLIANCE', 'EMERGENCY'],
    ['Outlet in living room is sparking', 'ELECTRICAL', 'EMERGENCY'],
    ['Smoke detector keeps beeping', 'ELECTRICAL', 'NORMAL'],
    ['Cosmetic paint scuff in the hallway', 'STRUCTURAL', 'LOW'],
    ['Small slow leak under the bathroom sink', 'PLUMBING', 'NORMAL'],
  ])('%s → %s / %s', (text, cat, urg) => {
    const c = classifyCategory(text);
    expect(c).toBe(cat);
    expect(classifyUrgency(text, c, summer).urgency).toBe(urg);
  });

  it('treats no heat as an emergency only in the cold season', () => {
    expect(classifyUrgency('No heat, radiators cold', 'HVAC', winter).urgency).toBe('EMERGENCY');
    expect(classifyUrgency('No heat, radiators cold', 'HVAC', summer).urgency).toBe('HIGH');
  });

  it('matches assets by name, never by room word alone or across rooms', () => {
    const assets = [
      { id: 'sink', name: 'Kitchen sink', category: 'PLUMBING', unit_id: 'u' },
      { id: 'toilet', name: 'Bathroom toilet', category: 'PLUMBING', unit_id: 'u' },
      { id: 'wh', name: 'Water heater', category: 'PLUMBING', unit_id: null },
      { id: 'fridge', name: 'Refrigerator', category: 'APPLIANCE', unit_id: 'u' },
    ];
    expect(matchAsset('The fridge is warm', assets, 'APPLIANCE')?.id).toBe('fridge');
    expect(matchAsset('No hot water', assets, 'PLUMBING')?.id).toBe('wh');
    expect(matchAsset('Leak in the kitchen ceiling', assets, 'PLUMBING')).toBeUndefined();
    expect(matchAsset('Bathroom faucet drips', assets, 'PLUMBING')).toBeUndefined();
    // Regression: "water" alone must not link a bathroom leak to the water heater
    expect(matchAsset('The pipe under the bathroom sink is leaking and water is collecting', assets, 'PLUMBING')).toBeUndefined();
    const withBath = [...assets, { id: 'bath', name: 'Bathroom sink', category: 'PLUMBING', unit_id: 'u' }];
    expect(matchAsset('The pipe under the bathroom sink is leaking and water is collecting', withBath, 'PLUMBING')?.id).toBe('bath');
    expect(matchAsset('Bathroom faucet drips', withBath, 'PLUMBING')?.id).toBe('bath');
  });

  it('scores word overlap for duplicate detection', () => {
    expect(similarity('Kitchen sink leaking under the cabinet', 'Sink still leaking into the kitchen cabinet')).toBeGreaterThan(0.3);
    expect(similarity('Kitchen sink leaking', 'Closet door squeaks')).toBe(0);
  });
});

describe('tool definitions and input validation', () => {
  it('has 19 uniquely named tools split across run types', () => {
    expect(new Set(TOOL_DEFS.map((t) => t.tool.name)).size).toBe(19);
    expect(toolsForRun('TRIAGE')).toHaveLength(10);
    expect(toolsForRun('NIGHTLY_DIGEST')).toHaveLength(13);
    // Claude rejects unknown fields on tool definitions; the access tags must be stripped
    expect(Object.keys(toolsForRun('TRIAGE')[0]).sort()).toEqual(['description', 'input_schema', 'name']);
  });

  const schema = TOOL_DEFS.find((t) => t.tool.name === 'find_similar_requests')!.tool.input_schema;
  it('applies defaults, coerces numeric strings and drops unknown keys', () => {
    const r = validateInput(schema, { property_id: '7bbe4501-6d96-4e4a-a9b8-461b76fc27c4', days_back: '10', extra: 1 });
    expect(r).toEqual({ ok: true, value: { property_id: '7bbe4501-6d96-4e4a-a9b8-461b76fc27c4', days_back: 10 } });
    const d = validateInput(schema, { property_id: '7bbe4501-6d96-4e4a-a9b8-461b76fc27c4' });
    expect(d.ok && d.value.days_back).toBe(30);
  });

  it('reports every problem in one message', () => {
    const r = validateInput(schema, { days_back: 900, category: 'NOPE', unit_id: 'abc' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual(expect.arrayContaining([
        'property_id is required', 'days_back must be <= 365', expect.stringMatching(/^category must be one of/), 'unit_id must be a UUID',
      ]));
    }
  });
});
