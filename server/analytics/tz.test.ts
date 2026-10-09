import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { isValidTimeZone, offsetAt, offsetSegments, TzContext } from './tz.ts';

const H = 3_600_000;
const db = new DatabaseSync(':memory:');
/** Evaluates a TzContext SQL expression for one timestamp. */
function evalSql(expr: string, ts: number): number {
  return Number((db.prepare(`SELECT ${expr} AS v FROM (SELECT CAST(? AS INTEGER) AS timestamp_ms)`).get(ts) as { v: number }).v);
}

describe('offsets', () => {
  it('reads fixed and half/quarter-hour offsets', () => {
    assert.equal(offsetAt('UTC', Date.UTC(2026, 9, 9)), 0);
    assert.equal(offsetAt('Asia/Kolkata', Date.UTC(2026, 9, 9)), 5.5 * H);
    assert.equal(offsetAt('Asia/Kathmandu', Date.UTC(2026, 9, 9)), 5.75 * H);
    assert.equal(isValidTimeZone('Mars/Base'), false);
    assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  });

  it('finds New York DST transitions to the second', () => {
    const segs = offsetSegments('America/New_York', Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
    assert.deepEqual(
      segs.slice(1).map((s) => [new Date(s.start).toISOString(), s.offset / H]),
      [
        ['2026-03-08T07:00:00.000Z', -4],
        ['2026-11-01T06:00:00.000Z', -5],
      ],
    );
    assert.equal(segs[0].offset, -5 * H);
    assert.equal(offsetSegments('Asia/Kolkata', Date.UTC(2020, 0, 1), Date.UTC(2026, 0, 1)).length, 1);
  });
});

describe('TzContext buckets', () => {
  it('aligns hour buckets to :30 for Asia/Kolkata', () => {
    const tz = new TzContext('Asia/Kolkata', Date.UTC(2026, 9, 9), Date.UTC(2026, 9, 10));
    const ts = Date.parse('2026-10-09T05:45:12Z'); // 11:15 local
    const bucket = evalSql(tz.hourBucketSql, ts);
    assert.equal(new Date(bucket).toISOString(), '2026-10-09T05:30:00.000Z');
    assert.equal(tz.hourLabel(bucket), '11:00');
    const day = tz.dayStart(evalSql(tz.dayKeySql, ts));
    assert.equal(new Date(day).toISOString(), '2026-10-08T18:30:00.000Z');
    assert.equal(tz.dayLabel(day), '10/09');
  });

  it('aligns hour buckets to :15 for Asia/Kathmandu', () => {
    const tz = new TzContext('Asia/Kathmandu', Date.UTC(2026, 9, 9), Date.UTC(2026, 9, 10));
    const bucket = evalSql(tz.hourBucketSql, Date.parse('2026-10-09T05:10:00Z')); // 10:55 local
    assert.equal(new Date(bucket).toISOString(), '2026-10-09T04:15:00.000Z');
    assert.equal(tz.hourLabel(bucket), '10:00');
  });

  it('computes local weekday and hour', () => {
    const tz = new TzContext('Asia/Kolkata', Date.UTC(2026, 9, 9), Date.UTC(2026, 9, 11));
    const ts = Date.parse('2026-10-09T20:00:00Z'); // Sat 2026-10-10 01:30 IST
    assert.equal(evalSql(tz.weekdaySql, ts), 6);
    assert.equal(evalSql(tz.hourOfDaySql, ts), 1);
  });

  it('handles the New York spring-forward day', () => {
    const from = Date.parse('2026-03-08T05:00:00Z');
    const tz = new TzContext('America/New_York', from, from + 2 * 86_400_000);
    // 01:30 EST and 03:30 EDT are one wall-clock hour apart but two real hours.
    const before = Date.parse('2026-03-08T06:30:00Z');
    const after = Date.parse('2026-03-08T07:30:00Z');
    assert.equal(new Date(evalSql(tz.hourBucketSql, before)).toISOString(), '2026-03-08T06:00:00.000Z');
    assert.equal(new Date(evalSql(tz.hourBucketSql, after)).toISOString(), '2026-03-08T07:00:00.000Z');
    assert.equal(tz.hourLabel(Date.parse('2026-03-08T07:00:00Z')), '03:00');
    assert.equal(evalSql(tz.hourOfDaySql, after), 3);
    // Both are on local Mar 8, whose midnight is 05:00Z (EST); Mar 9 starts at 04:00Z (EDT).
    const key = evalSql(tz.dayKeySql, before);
    assert.equal(evalSql(tz.dayKeySql, after), key);
    assert.equal(new Date(tz.dayStart(key)).toISOString(), '2026-03-08T05:00:00.000Z');
    assert.equal(new Date(tz.dayStart(key + 1)).toISOString(), '2026-03-09T04:00:00.000Z');
    assert.equal(tz.dayLabel(tz.dayStart(key + 1)), '03/09');
  });

  it('keeps the repeated fall-back hour as two buckets', () => {
    const from = Date.parse('2026-11-01T04:00:00Z');
    const tz = new TzContext('America/New_York', from, from + 86_400_000);
    const first = Date.parse('2026-11-01T05:30:00Z'); // 01:30 EDT
    const second = Date.parse('2026-11-01T06:30:00Z'); // 01:30 EST
    const b1 = evalSql(tz.hourBucketSql, first);
    const b2 = evalSql(tz.hourBucketSql, second);
    assert.equal(b2 - b1, H);
    assert.equal(tz.hourLabel(b1), '01:00');
    assert.equal(tz.hourLabel(b2), '01:00');
    assert.equal(evalSql(tz.dayKeySql, first), evalSql(tz.dayKeySql, second));
    assert.equal(new Date(tz.dayStart(evalSql(tz.dayKeySql, first))).toISOString(), '2026-11-01T04:00:00.000Z');
  });

  it('emits a single constant offset for fixed zones', () => {
    const tz = new TzContext('Asia/Kolkata', Date.UTC(2021, 0, 1), Date.UTC(2026, 0, 1));
    assert.equal(tz.localSql, '(timestamp_ms + 19800000)');
  });
});
