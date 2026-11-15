import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { keccak256, toHex } from 'viem';
import { deploy } from '../scripts/local.js';

test('the interactive demo can create a tender after the wall clock passes its simulated deadline', async () => {
  const local = await deploy({ manualTime: true });
  try {
    const before = await local.timestamp();
    const end = before + 2n;
    await setTimeout(2600);
    const id = keccak256(toHex('idle browser'));
    const rules = keccak256(toHex('lowest eligible bid'));
    await local.write(local.buyer, 'createTender', [id, rules, end, end + 5n, end + 10n, [local.supplierA]]);
    assert.equal(await local.timestamp(), before + 1n);
    assert.equal((await local.read('tenders', [id]))[4], 1);
  } finally {
    await local.close();
  }
});
