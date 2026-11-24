import { describe, expect, it } from 'vitest';
import {
  broadcastOf,
  formatIp,
  hostCount,
  inSubnet,
  isUsableHost,
  maskFromPrefix,
  networkOf,
  parseCidr,
  parseIp,
  parseMac,
  parseMask,
  prefixFromMask,
} from '../src/sim/net/addr';

describe('IPv4 parsing', () => {
  it('parses valid addresses', () => {
    expect(parseIp('192.168.1.10')).toBe(0xc0a8010a);
    expect(parseIp('0.0.0.0')).toBe(0);
    expect(parseIp('255.255.255.255')).toBe(0xffffffff);
    expect(formatIp(parseIp('10.20.30.40')!)).toBe('10.20.30.40');
  });

  it.each(['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', 'a.b.c.d', '', ' . . . ', '1..2.3', '-1.2.3.4', '1.2.3.4/24'])(
    'rejects %j',
    (bad) => expect(parseIp(bad)).toBeNull(),
  );

  it('rejects absurdly long input without work', () => {
    expect(parseIp('1'.repeat(10_000))).toBeNull();
  });
});

describe('masks and subnets', () => {
  it('converts between prefixes and masks', () => {
    expect(formatIp(maskFromPrefix(24))).toBe('255.255.255.0');
    expect(formatIp(maskFromPrefix(0))).toBe('0.0.0.0');
    expect(formatIp(maskFromPrefix(32))).toBe('255.255.255.255');
    for (let p = 0; p <= 32; p++) expect(prefixFromMask(maskFromPrefix(p))).toBe(p);
  });

  it('rejects non-contiguous masks', () => {
    expect(prefixFromMask(parseIp('255.0.255.0')!)).toBeNull();
    expect(parseMask('255.255.0.255')).toBeNull();
    expect(parseMask('255.255.252.0')).toBe(22);
    expect(parseMask('/27')).toBe(27);
    expect(parseMask('/33')).toBeNull();
  });

  it('computes network and broadcast addresses', () => {
    const a = parseIp('192.168.10.77')!;
    expect(formatIp(networkOf(a, 26))).toBe('192.168.10.64');
    expect(formatIp(broadcastOf(a, 26))).toBe('192.168.10.127');
    expect(inSubnet(parseIp('192.168.10.100')!, a, 26)).toBe(true);
    expect(inSubnet(parseIp('192.168.10.130')!, a, 26)).toBe(false);
    expect(isUsableHost(parseIp('192.168.10.64')!, 26)).toBe(false);
    expect(isUsableHost(parseIp('192.168.10.65')!, 26)).toBe(true);
    expect(hostCount(24)).toBe(254);
    expect(hostCount(30)).toBe(2);
  });

  it('parses CIDR and MACs strictly', () => {
    expect(parseCidr('10.0.0.0/8')).toEqual({ ip: 0x0a000000, prefix: 8 });
    expect(parseCidr('10.0.0.0/8/1')).toBeNull();
    expect(parseCidr('10.0.0.0')).toBeNull();
    expect(parseMac('AA-BB-CC-00-11-22')).toBe('aa:bb:cc:00:11:22');
    expect(parseMac('aa:bb:cc:00:11')).toBeNull();
  });
});
