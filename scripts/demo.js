import assert from 'node:assert/strict';
import { keccak256, toHex } from 'viem';
import { deploy } from './local.js';
import { commitment, evaluate, makeOpening, receiptFor, verifyAward } from './evaluate.js';

const local = await deploy();
try {
  const { buyer, evaluator, auditor, intake, supplierA, supplierB } = local;
  console.log('Deployed TenderLedger on local Hardhat chain 31337.');
  const ruleDigest = keccak256(toHex('Lowest eligible integer KZT bid wins; ties use earliest accepted commitment.'));
  const suppliers = [supplierA, supplierB];
  const openings = [makeOpening(supplierA, 1_250_000n), makeOpening(supplierB, 1_100_000n)];

  async function runTender(label, omitCheapest) {
    const tender = keccak256(toHex(label));
    const context = { tender, ruleDigest, registry: local.address, chainId: 31337n };
    const now = await local.timestamp();
    const [commitEnd, revealEnd, reviewEnd] = [now + 60n, now + 120n, now + 180n];
    await local.write(buyer, 'createTender', [tender, ruleDigest, commitEnd, revealEnd, reviewEnd, suppliers]);
    for (const opening of openings) {
      await local.write(opening.supplier, 'commitBid', [tender, commitment(context, opening)]);
    }
    await local.advance(commitEnd);
    for (const opening of openings) {
      const [sealed] = await local.read('bids', [tender, opening.supplier]);
      assert.equal(sealed, commitment(context, opening));
      await local.write(intake, 'attestDelivery', [tender, opening.supplier, receiptFor(sealed)]);
    }
    console.log(label + ': intake confirms both timely openings independently.');
    const evaluationOpenings = omitCheapest ? [openings[0]] : openings;
    for (const opening of evaluationOpenings) {
      await local.write(evaluator, 'recordRevealReceipt', [
        tender, opening.supplier, receiptFor(commitment(context, opening)),
      ]);
    }
    await local.advance(revealEnd);
    await local.write(supplierA, 'closeTender', [tender]);
    async function readBids() {
      return Promise.all(suppliers.map(async supplier => {
        const [commitment, receipt, sequence, delivery] = await local.read('bids', [tender, supplier]);
        return { supplier, commitment, receipt, sequence, delivery };
      }));
    }
    const result = evaluate(context, await readBids(), evaluationOpenings);
    assert.equal(result.winner.toLowerCase(), (omitCheapest ? supplierA : supplierB).toLowerCase());
    await local.write(evaluator, 'proposeResult', [tender, result.winner, result.resultDigest]);
    const reviewerRecords = await readBids();
    if (omitCheapest) {
      console.log('Evaluator leaves out Supplier B (KZT 1,100,000) and proposes Supplier A.');
      assert.throws(() => verifyAward(context, reviewerRecords, openings), /Timely bid omitted/);
      console.log('Reviewer finds B in the independent delivery record and refuses approval.');
      await local.write(auditor, 'holdAward', [tender, keccak256(toHex('Unreconciled timely delivery'))]);
      const record = await local.read('tenders', [tender]);
      assert.equal(record[4], 5);
      console.log('Ledger status: HELD. No award was recorded.');
    } else {
      const audit = verifyAward(context, reviewerRecords, [...openings].reverse());
      assert.deepEqual(audit, result);
      await local.write(auditor, 'finalizeResult', [tender, audit.winner, audit.resultDigest]);
      assert.equal((await local.read('tenders', [tender]))[4], 3);
      console.log('Reviewer reconciles both openings. Supplier B wins the clean tender.');
    }
  }

  await runTender('Omitted-bid case', true);
  await runTender('Clean comparison', false);
} finally {
  await local.close();
}
