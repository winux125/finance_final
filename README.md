Educational project for the course Introduction to Finance. Not a real product, service or investment offer. Do not use with real funds.

# TenderSeal

A local prototype for sealed corporate procurement. The buyer locks eligible suppliers, rules and deadlines. Suppliers commit a salted hash. A separate intake account attests delivery after checking openings in the simulation. The evaluator records matching receipts and proposes a result. The procurement compliance reviewer checks both records and either approves a matching award or records a hold. The contract stores no plaintext prices or salts and moves no funds.

Watch the [55-second demo](https://github.com/winux125/finance_final/blob/main/demo/TenderSeal_Demo.mp4). It shows what happens when the evaluator leaves out the lowest bid, then shows a clean run with both bids included.

## Run

Use Node.js 22.13 or newer and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm demo
pnpm test
python finance.py
```

The initial install downloads locked packages including the Solidity compiler. Each demo and test deploys to an in-process Hardhat chain, chain ID 31337, with generated test accounts. The demo shows the reviewer holding a tender when the evaluator leaves out Supplier B, the lowest valid bid. A separate clean tender awards to B. There is no mainnet or testnet deployment.

## Run the interactive demo

Run `pnpm demo:web` after installing dependencies, then open [http://127.0.0.1:4173/](http://127.0.0.1:4173/) in a browser. Keep the terminal open while using the demo. Press Ctrl+C in the terminal to stop it.

1. Enter two synthetic bid amounts and click **Seal bids**.
2. Select **Leave Supplier B out of the evaluation** to demonstrate an omission, or leave it unchecked for a clean tender. Click **Open bids and propose award**.
3. Compare the intake and evaluation records. In the omission case, **Approve award** explains the mismatch and **Hold award** records the hold. In a clean tender, **Approve award** finalizes the lowest eligible bid.
4. Click **New tender** to try the other outcome. The local server deploys TenderLedger on startup and sends real transactions to that local simulation as you click. The server keeps the test prices and salts in memory.

If the contract is already compiled and the dependencies are installed, `node scripts/demo-web.js` starts the web demo directly.

## Read the code

- `contracts/TenderLedger.sol` holds the tender state and the role and deadline checks.
- `scripts/evaluate.js` defines the commitment, receipt and private ranking rules. It uses exact positive integer KZT and ledger acceptance sequence as a tie-break.
- `scripts/demo.js` runs the buyer, supplier, evaluator and auditor steps.
- `scripts/local.js` provides the in-process deployment and transaction helpers.
- `test/tender.test.js` exercises eleven groups of state, timing, access and review cases.
- `finance.py` reconstructs the original Endterm calculation and prints the updated statements and scenarios as JSON.

## Trust assumptions

The demo simulates intake and review using separate local accounts. A deployed system needs a delivery channel controlled outside procurement, supplier access to delivery acknowledgements and private access for the reviewer. The contract rejects finalization when delivery and receipt counts differ because each evaluation receipt must match a unique delivery. After the review deadline, any caller can record a hold and finalization is unavailable. If intake itself fails to attest, supplier escalation and retained evidence are needed. A matching award depends on private verification of prices. The local contract does not implement encrypted storage, role recovery or production consensus. Addresses, timing, participation and the winning address are visible to permitted readers.

Hardhat and EDR are from the Nomic Foundation. Viem is used for ABI encoding and interaction with the simulated network. Solidity is compiled with solc-js. Upstream packages retain their own licenses. No Solidity sample contract was copied. OpenAI Codex (GPT-6 series) assisted with research, analysis, draft materials, the contract, demo and tests. Confirm the exact session model and reflect actual contributions before submission.
