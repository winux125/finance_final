import { randomBytes } from 'node:crypto';
import { encodeAbiParameters, keccak256, toHex, zeroAddress } from 'viem';

const typedHash = (types, values) => keccak256(encodeAbiParameters(types.map(type => ({ type })), values));
const bidDomain = keccak256(toHex('TenderSeal.bid.v1'));

export function makeOpening(supplier, price, salt = toHex(randomBytes(32))) {
  if (typeof price !== 'bigint' || price <= 0n) throw new Error('Price must be positive integer KZT');
  return { supplier, price, salt };
}

export function commitment(context, opening) {
  return typedHash(
    ['bytes32','uint256','address','bytes32','bytes32','address','uint256','bytes32'],
    [bidDomain, context.chainId, context.registry, context.tender, context.ruleDigest,
      opening.supplier, opening.price, opening.salt],
  );
}

export function receiptFor(sealed) {
  return typedHash(['bytes32','bytes32'], [keccak256(toHex('TenderSeal.receipt.v1')), sealed]);
}

export function verifyAward(context, ledgerBids, privateOpenings) {
  const missing = ledgerBids.filter(bid => bid.delivery !== bid.receipt);
  if (missing.length) throw new Error('Timely bid omitted from evaluation');
  return evaluate(context, ledgerBids, privateOpenings);
}

export function evaluate(context, ledgerBids, openings) {
  const bySupplier = new Map(openings.map(o => [o.supplier.toLowerCase(), o]));
  if (bySupplier.size !== openings.length) throw new Error('Duplicate private opening');
  const zero = '0x' + '0'.repeat(64);
  const accepted = [];
  for (const bid of ledgerBids) {
    const opening = bySupplier.get(bid.supplier.toLowerCase());
    if (bid.receipt === zero) continue;
    if (!opening || commitment(context, opening) !== bid.commitment || receiptFor(bid.commitment) !== bid.receipt) {
      throw new Error('Recorded receipt has no matching opening');
    }
    accepted.push({ ...bid, price: opening.price });
  }
  const ranked = [...accepted].sort((a, b) =>
    a.price === b.price ? a.sequence - b.sequence : a.price < b.price ? -1 : 1,
  );
  const winner = ranked[0]?.supplier ?? zeroAddress;
  const ordered = [...accepted].sort((a, b) => a.sequence - b.sequence);
  const resultDigest = typedHash(
    ['bytes32','uint256','address','bytes32','bytes32','address','bytes32[]'],
    [keccak256(toHex('TenderSeal.result.v1')), context.chainId, context.registry,
      context.tender, context.ruleDigest, winner, ordered.map(bid => bid.commitment)],
  );
  return { winner, resultDigest };
}
