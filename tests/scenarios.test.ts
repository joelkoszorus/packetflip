import { describe, expect, it } from 'vitest';
import { Network } from '../src/sim';
import { SCENARIOS, scoreStars, spentOn } from '../src/game/scenarios';
import { runChecks } from '../src/game/objectives';

describe.each(SCENARIOS.map((s) => [s.title, s] as const))('scenario %s', (_title, scenario) => {
  function start() {
    const net = new Network();
    scenario.setup(net);
    const devs = new Set(net.devices.keys());
    const links = new Set(net.links.keys());
    return { net, devs, links };
  }

  it('starts unsolved', () => {
    const { net } = start();
    const results = runChecks(net, scenario.objectives);
    expect(results.some((r) => !r.pass)).toBe(true);
  });

  it('the reference solution passes every objective and best practice within budget', () => {
    const { net, devs, links } = start();
    scenario.solve(net);
    const results = runChecks(net, [...scenario.objectives, ...scenario.bestPractice]);
    for (const r of results) expect(r.pass, `${r.label}: ${r.detail}`).toBe(true);
    expect(spentOn(net, devs, links)).toBeLessThanOrEqual(scenario.budget);
  });

  it('checks do not disturb the live network', () => {
    const { net } = start();
    const before = net.engine.now;
    runChecks(net, scenario.objectives);
    expect(net.engine.now).toBe(before);
    expect(net.engine.pending).toBe(0);
  });
});

describe('scoring', () => {
  it('awards stars for completion, budget + par, and best practice', () => {
    expect(scoreStars(false, 0, 100, 10, 300, true).stars).toBe(0);
    expect(scoreStars(true, 120, 100, 10, 300, false).stars).toBe(1);
    expect(scoreStars(true, 90, 100, 10, 300, false).stars).toBe(2);
    expect(scoreStars(true, 90, 100, 10, 300, true).stars).toBe(3);
    expect(scoreStars(true, 90, 100, 400, 300, true).stars).toBe(2);
  });
});
