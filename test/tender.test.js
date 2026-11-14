import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { encodeFunctionData, keccak256, toHex, zeroAddress, zeroHash } from 'viem';
import { deploy } from '../scripts/local.js';
import { commitment, evaluate, makeOpening, receiptFor, verifyAward } from '../scripts/evaluate.js';

let local, context, end, close, reviewEnd, openings, sealed;
const tender = keccak256(toHex('synthetic tender'));
const ruleDigest = keccak256(toHex('lowest price, earliest commitment if tied'));

beforeEach(async () => {
  local = await deploy();
  context = { tender, ruleDigest, registry: local.address, chainId: 31337n };
  const now = await local.timestamp();
  end = now + 60n;
  close = end + 60n;
  reviewEnd = close + 60n;
  openings = [makeOpening(local.supplierA, 200n), makeOpening(local.supplierB, 100n)];
  sealed = openings.map(o => commitment(context, o));
  await local.write(local.buyer, 'createTender', [tender, ruleDigest, end, close, reviewEnd, openings.map(o => o.supplier)]);
});
afterEach(async () => { await local.close(); });

function commit(i) { return local.write(openings[i].supplier, 'commitBid', [tender, sealed[i]]); }
function receipt(i) {
  return local.write(local.evaluator, 'recordRevealReceipt', [tender, openings[i].supplier, receiptFor(sealed[i])]);
}
function deliver(i, caller = local.intake) {
  return local.write(caller, 'attestDelivery', [tender, openings[i].supplier, receiptFor(sealed[i])]);
}
async function closeTender() {
  await local.advance(close);
  return local.write(local.stranger, 'closeTender', [tender]);
}
async function ledgerRecords() {
  return Promise.all(openings.map(async ({ supplier }) => {
    const [commitment, receipt, sequence, delivery] = await local.read('bids', [tender, supplier]);
    return { supplier, commitment, receipt, sequence, delivery };
  }));
}

test('buyer cannot overwrite activated rules and outsiders cannot create tenders', async () => {
  const args = [tender, ruleDigest, end, close, reviewEnd, [local.supplierA]];
  await assert.rejects(local.write(local.stranger, 'createTender', args), /Unauthorized/);
  await assert.rejects(local.write(local.buyer, 'createTender', args), /Duplicate/);
  assert.equal((await local.read('tenders', [tender]))[0], ruleDigest);
});

test('unlisted suppliers and empty commitments are rejected', async () => {
  await assert.rejects(local.write(local.stranger, 'commitBid', [tender, sealed[0]]), /Unauthorized/);
  await assert.rejects(local.write(local.supplierA, 'commitBid', [tender, zeroHash]), /InvalidDigest/);
});

test('duplicate bid rejected and commitment transaction contains no price or salt argument', async () => {
  const transaction = await commit(0);
  const abi = [{type:'function',name:'commitBid',inputs:[{type:'bytes32'},{type:'bytes32'}],outputs:[]}];
  assert.equal(transaction.input, encodeFunctionData({abi, functionName:'commitBid', args:[tender,sealed[0]]}));
  await assert.rejects(commit(0), /Duplicate/);
});

test('late bid, early reveal, early closure and late reveal rejected', async () => {
  await commit(0);
  await assert.rejects(receipt(0), /IncorrectPhase/);
  await assert.rejects(local.write(local.auditor, 'closeTender', [tender]), /IncorrectPhase/);
  await local.advance(end);
  await assert.rejects(commit(1), /IncorrectPhase/);
  await assert.rejects(deliver(0, local.evaluator), /Unauthorized/);
  await local.advance(close);
  await assert.rejects(receipt(0), /IncorrectPhase/);
  await assert.rejects(deliver(0), /IncorrectPhase/);
});

test('only evaluator can record one receipt for an existing commitment', async () => {
  await commit(0);
  await local.advance(end);
  await assert.rejects(local.write(local.auditor, 'recordRevealReceipt', [tender, local.supplierA, sealed[0]]), /Unauthorized/);
  await assert.rejects(receipt(1), /MissingBid/);
  await assert.rejects(receipt(0), /MissingBid/);
  await deliver(0);
  await receipt(0);
  await assert.rejects(receipt(0), /Duplicate/);
});

test('off-chain audit rejects modified price or missing opening', async () => {
  await commit(0);
  await local.advance(end);
  await deliver(0);
  await receipt(0);
  const recorded = await ledgerRecords();
  assert.throws(() => evaluate(context, recorded, []), /no matching opening/);
  assert.throws(() => evaluate(context, recorded, [{ ...openings[0], price: 1n }]), /no matching opening/);
});

test('tie uses contract sequence independent of the evaluation input order', async () => {
  openings[1] = makeOpening(local.supplierB, 200n);
  sealed[1] = commitment(context, openings[1]);
  await commit(1);
  await commit(0);
  await local.advance(end);
  await deliver(0);
  await deliver(1);
  await receipt(0);
  await receipt(1);
  const recorded = await ledgerRecords();
  assert.equal(evaluate(context, recorded, openings).winner.toLowerCase(), local.supplierB.toLowerCase());
  assert.deepEqual(evaluate(context, recorded, openings), evaluate(context, [...recorded].reverse(), [...openings].reverse()));
});

test('two matching roles finalize only once', async () => {
  await commit(0);
  await commit(1);
  await local.advance(end);
  await deliver(0);
  await deliver(1);
  await receipt(0);
  await receipt(1);
  await closeTender();
  const { winner, resultDigest } = evaluate(context, await ledgerRecords(), openings);
  assert.equal(winner.toLowerCase(), local.supplierB.toLowerCase());
  await assert.rejects(local.write(local.buyer, 'proposeResult', [tender,winner,resultDigest]), /Unauthorized/);
  await local.write(local.evaluator, 'proposeResult', [tender,winner,resultDigest]);
  await assert.rejects(local.write(local.evaluator, 'finalizeResult', [tender,winner,resultDigest]), /Unauthorized/);
  await assert.rejects(local.write(local.auditor, 'finalizeResult', [tender,winner,sealed[0]]), /ResultMismatch/);
  await local.write(local.auditor, 'finalizeResult', [tender,winner,resultDigest]);
  assert.equal((await local.read('tenders', [tender]))[4], 3);
  await assert.rejects(local.write(local.auditor, 'finalizeResult', [tender,winner,resultDigest]), /IncorrectPhase/);
});

test('reviewer holds an incomplete award and silence expires the review', async () => {
  await commit(0);
  await commit(1);
  await local.advance(end);
  await deliver(0);
  await deliver(1);
  await receipt(0);
  await closeTender();
  const records = await ledgerRecords();
  const incomplete = evaluate(context, records, [openings[0]]);
  assert.throws(() => verifyAward(context, records, openings), /Timely bid omitted/);
  await local.write(local.evaluator, 'proposeResult', [tender, incomplete.winner, incomplete.resultDigest]);
  await assert.rejects(local.write(local.auditor, 'finalizeResult', [tender, incomplete.winner, incomplete.resultDigest]), /IncompleteReceipts/);
  await assert.rejects(local.write(local.buyer, 'holdAward', [tender, sealed[1]]), /Unauthorized/);
  await assert.rejects(local.write(local.stranger, 'expireReview', [tender]), /IncorrectPhase/);
  await local.write(local.auditor, 'holdAward', [tender, sealed[1]]);
  assert.equal((await local.read('tenders', [tender]))[4], 5);
  await assert.rejects(local.write(local.auditor, 'finalizeResult', [tender, incomplete.winner, incomplete.resultDigest]), /IncorrectPhase/);
});

test('anyone can record a hold after the review deadline without accepting a late award', async () => {
  await closeTender();
  const review = evaluate(context, await ledgerRecords(), []);
  await local.write(local.evaluator, 'proposeResult', [tender, review.winner, review.resultDigest]);
  await local.advance(reviewEnd);
  await assert.rejects(local.write(local.auditor, 'finalizeResult', [tender, review.winner, review.resultDigest]), /IncorrectPhase/);
  await local.write(local.stranger, 'expireReview', [tender]);
  assert.equal((await local.read('tenders', [tender]))[4], 5);
});

test('supplier without a receipt is excluded and no-award can be certified', async () => {
  await commit(0);
  await closeTender();
  const { winner, resultDigest } = evaluate(context, await ledgerRecords(), []);
  assert.equal(winner, zeroAddress);
  await assert.rejects(local.write(local.evaluator, 'proposeResult', [tender,local.supplierA,resultDigest]), /MissingBid/);
  await local.write(local.evaluator, 'proposeResult', [tender,winner,resultDigest]);
  await local.write(local.auditor, 'finalizeResult', [tender,winner,resultDigest]);
  assert.equal((await local.read('tenders', [tender]))[4], 4);
});
