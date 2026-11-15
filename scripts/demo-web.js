import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { keccak256, toHex, zeroAddress } from 'viem';
import { deploy } from './local.js';
import { commitment, evaluate, makeOpening, receiptFor, verifyAward } from './evaluate.js';

const host = '127.0.0.1';
const port = Number(process.env.TENDERSEAL_DEMO_PORT ?? 4173);
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/demo.css': ['demo.css', 'text/css; charset=utf-8'],
  '/demo.js': ['demo.js', 'text/javascript; charset=utf-8'],
};
const emptyDigest = '0x' + '0'.repeat(64);
const ruleDigest = keccak256(toHex('Lowest eligible integer KZT bid wins; ties use earliest accepted commitment.'));
const local = await deploy({ manualTime: true });
const suppliers = [local.supplierA, local.supplierB];
let tender;
let revision = 0;
let busy = false;

class InputError extends Error {}

function requireStage(stage) {
  if (tender?.stage !== stage) throw new InputError('This action is unavailable at the current step.');
}

function readPrice(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,14}$/.test(value)) {
    throw new InputError('Enter both bids as whole KZT amounts from 1 to 999,999,999,999,999.');
  }
  return BigInt(value);
}

async function readBids() {
  return Promise.all(suppliers.map(async supplier => {
    const [sealed, receipt, sequence, delivery] = await local.read('bids', [tender.id, supplier]);
    return { supplier, commitment: sealed, receipt, sequence, delivery };
  }));
}

function supplierName(address) {
  if (!address || address === zeroAddress) return null;
  return address.toLowerCase() === suppliers[0].toLowerCase() ? 'A' : 'B';
}

function snapshot() {
  const current = tender;
  const currentRevision = revision;
  const stage = current?.stage ?? 'entry';
  const details = current?.reviewBids;
  return {
    revision: currentRevision,
    stage,
    contract: local.address,
    transaction: current?.transaction ?? null,
    proposed: supplierName(current?.proposal?.winner),
    decision: current?.decision ?? null,
    bids: details?.map((bid, i) => ({
      supplier: i === 0 ? 'A' : 'B',
      price: current.openings[i].price.toString(),
      delivered: bid.delivery !== emptyDigest,
      evaluated: bid.receipt !== emptyDigest,
    })) ?? [],
  };
}

async function write(account, method, args) {
  const tx = await local.write(account, method, args);
  tender.transaction = tx.hash;
}

async function seal(body) {
  if (tender) throw new InputError('Start a new tender before sealing another pair of bids.');
  const prices = [readPrice(body.priceA), readPrice(body.priceB)];
  const id = toHex(randomBytes(32));
  const now = await local.timestamp();
  // The demo advances simulated time at each phase boundary.
  const commitEnd = now + 600n;
  const revealEnd = commitEnd + 600n;
  const reviewEnd = revealEnd + 600n;
  const context = { tender: id, registry: local.address, ruleDigest, chainId: 31337n };
  const openings = suppliers.map((supplier, i) => makeOpening(supplier, prices[i]));
  tender = { id, context, openings, commitEnd, revealEnd, stage: 'error' };
  await write(local.buyer, 'createTender', [id, ruleDigest, commitEnd, revealEnd, reviewEnd, suppliers]);
  for (const opening of openings) {
    await write(opening.supplier, 'commitBid', [id, commitment(context, opening)]);
  }
  tender.stage = 'sealed';
}

async function propose(body) {
  requireStage('sealed');
  if (typeof body.omitB !== 'boolean') throw new InputError('Choose which bids to include in the evaluation.');
  const { id, commitEnd, revealEnd, openings, context } = tender;
  tender.stage = 'error';
  await local.advance(commitEnd);
  const committed = await readBids();
  for (const [i, opening] of openings.entries()) {
    if (commitment(context, opening) !== committed[i].commitment) {
      throw new Error('Opening digest differs from the sealed bid');
    }
    await write(local.intake, 'attestDelivery', [id, opening.supplier, receiptFor(committed[i].commitment)]);
  }
  const included = body.omitB ? openings.slice(0, 1) : openings;
  for (const opening of included) {
    await write(local.evaluator, 'recordRevealReceipt', [id, opening.supplier, receiptFor(commitment(context, opening))]);
  }
  await local.advance(revealEnd);
  await write(local.buyer, 'closeTender', [id]);
  tender.reviewBids = await readBids();
  tender.proposal = evaluate(context, tender.reviewBids, included);
  const { winner, resultDigest } = tender.proposal;
  await write(local.evaluator, 'proposeResult', [id, winner, resultDigest]);
  tender.stage = 'review';
}

async function decide(approve) {
  requireStage('review');
  const { id, context, openings } = tender;
  const bids = await readBids();
  if (approve && bids.some(bid => bid.delivery !== bid.receipt)) {
    throw new InputError('Approval is blocked. Supplier B has an intake receipt and is missing from the evaluation. Choose Hold award.');
  }
  const verified = approve ? verifyAward(context, bids, openings) : null;
  tender.stage = 'error';
  if (verified) {
    await write(local.auditor, 'finalizeResult', [id, verified.winner, verified.resultDigest]);
  } else {
    await write(local.auditor, 'holdAward', [id, keccak256(toHex('Held by the demo reviewer'))]);
  }
  const record = await local.read('tenders', [id]);
  if (record[4] !== (approve ? 3 : 5)) throw new Error('Unexpected tender state after reviewer action');
  tender.decision = approve ? `Awarded to Supplier ${supplierName(record[5])}` : 'Award held';
  tender.stage = 'finished';
}

const actions = new Map([
  ['seal', seal], ['propose', propose],
  ['approve', () => decide(true)], ['hold', () => decide(false)],
  ['reset', () => { tender = undefined; }],
]);

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 2048) throw new InputError('Request is too large.');
  }
  try {
    const value = JSON.parse(body);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new InputError('Send a valid JSON object.');
  }
}

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  const address = `${host}:${server.address().port}`;
  if (request.headers.host !== address || (request.headers.origin && request.headers.origin !== `http://${address}`)) {
    return send(response, 403, { error: 'Open the local demo URL printed in PowerShell.' });
  }
  try {
    if (request.method === 'GET' && Object.hasOwn(assets, request.url)) {
      const [file, mime] = assets[request.url];
      const content = await readFile(new URL(`../demo/web/${file}`, import.meta.url));
      response.writeHead(200, { 'Content-Type': mime });
      return response.end(content);
    }
    if (request.url !== '/api/tender') return send(response, 404, { error: 'Page not found.' });
    if (request.method === 'GET') {
      return busy ? send(response, 409, { error: 'A transaction is in progress. Try again in a moment.' }) : send(response, 200, snapshot());
    }
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
      return send(response, 415, { error: 'This action requires a JSON request.' });
    }
    const body = await readJson(request);
    if (busy || body.revision !== revision) {
      return send(response, 409, { error: 'The tender changed. Refresh the page and try again.' });
    }
    const action = actions.get(body.action);
    if (!action) throw new InputError('Choose an available tender action.');
    busy = true;
    try {
      await action(body);
      revision += 1;
      return send(response, 200, snapshot());
    } finally {
      busy = false;
    }
  } catch (error) {
    if (error instanceof InputError) return send(response, 400, { error: error.message });
    console.error(error);
    return send(response, 500, { error: 'The local transaction failed. Refresh the page and start a new tender if needed.' });
  }
});

server.listen(port, host, () => {
  console.log(`TenderSeal demo: http://${host}:${server.address().port}/`);
});
