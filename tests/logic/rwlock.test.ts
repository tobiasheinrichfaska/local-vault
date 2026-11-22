// The read/write lock the vault uses around blob writes (shared) and the sweep (exclusive).
import { describe, expect, it } from 'vitest';
import { RwLock } from '../../src/logic/lock.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('RwLock', () => {
  it('shared holders run together', async () => {
    const lock = new RwLock();
    let both = 0;
    let active = 0;
    const hold = () =>
      lock.run('shared', async () => {
        active++;
        both = Math.max(both, active);
        await tick();
        active--;
      });
    await Promise.all([hold(), hold(), hold()]);
    expect(both).toBe(3);
  });

  it('an exclusive holder runs alone: it waits for shared ones, and they wait for it', async () => {
    const lock = new RwLock();
    const log: string[] = [];
    const shared = (n: string) =>
      lock.run('shared', async () => {
        log.push(`${n}+`);
        await tick();
        log.push(`${n}-`);
      });
    const a = shared('a');
    const x = lock.run('exclusive', async () => {
      log.push('x+');
      await tick();
      log.push('x-');
    });
    const b = shared('b'); // arrives after the exclusive one: waits behind it
    await Promise.all([a, x, b]);
    expect(log).toEqual(['a+', 'a-', 'x+', 'x-', 'b+', 'b-']);
  });

  it('a failing task releases the lock and its error reaches the caller', async () => {
    const lock = new RwLock();
    await expect(
      lock.run('exclusive', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await lock.run('exclusive', async () => 7)).toBe(7);
  });
});
