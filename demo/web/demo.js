const byId = id => document.getElementById(id);
const bidsForm = byId('bids-form');
const evaluationForm = byId('evaluation-form');
const title = byId('status-title');
const detail = byId('status-detail');
const feedback = byId('feedback');
const amount = new Intl.NumberFormat('en-US');
const controls = [...document.querySelectorAll('main button')];
let state;
let busy = false;

function notify(message, error = false) {
  feedback.textContent = message;
  feedback.hidden = !message;
  feedback.dataset.error = String(error);
}

function setBusy(value) {
  busy = value;
  for (const control of controls) {
    control.disabled = value || (control.id === 'reset' && (!state || state.stage === 'entry'));
  }
}

function renderBlocks(blocks, history) {
  const list = byId('blocks');
  const byBlock = new Map(history.map(record => [record.block, record]));
  const nodes = blocks.map(block => {
    const record = byBlock.get(block.number);
    const action = record?.action ?? (block.number === '0' ? 'Genesis block' : 'Simulated time advanced');
    const item = document.createElement('li');
    const button = document.createElement('button');
    const cube = document.createElement('span');
    const label = document.createElement('span');
    button.type = 'button';
    button.className = 'block-node';
    button.setAttribute('aria-pressed', 'false');
    if (!record) button.dataset.kind = 'empty';
    else if (action === 'Award held') button.dataset.kind = 'held';
    else if (action.startsWith('Awarded to')) button.dataset.kind = 'awarded';
    cube.className = 'cube';
    cube.setAttribute('aria-hidden', 'true');
    label.textContent = `Block ${block.number}`;
    button.append(cube, label);
    item.append(button);
    const select = () => {
      list.querySelector('[aria-pressed="true"]')?.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-pressed', 'true');
      byId('block-heading').textContent = label.textContent;
      byId('block-action').textContent = action;
      byId('block-hash').textContent = block.hash;
      byId('parent-hash').textContent = block.parentHash ?? 'First block';
      byId('block-transaction').textContent = record?.hash ?? 'No transaction';
    };
    button.addEventListener('click', select);
    return { item, select };
  });
  list.replaceChildren(...nodes.map(node => node.item));
  byId('explorer').hidden = nodes.length === 0;
  nodes.at(-1)?.select();
  list.parentElement.scrollLeft = list.parentElement.scrollWidth;
}

function renderHistory(history) {
  byId('history-rows').replaceChildren(...history.toReversed().map(record => {
    const row = document.createElement('tr');
    const block = row.insertCell();
    const action = row.insertCell();
    const hash = document.createElement('code');
    block.textContent = record.block;
    action.textContent = record.action;
    if (record.tenderNumber !== null) {
      const tenderNumber = document.createElement('small');
      tenderNumber.textContent = `Tender ${record.tenderNumber}`;
      action.append(tenderNumber);
    }
    hash.textContent = record.hash;
    row.insertCell().append(hash);
    return row;
  }));
  byId('history-table').hidden = history.length === 0;
}

function render(next) {
  state = next;
  const { stage, decision, proposed, bids } = next;
  const omission = bids.find(bid => bid.delivered && !bid.evaluated);
  const step = ({ entry: 'entry', sealed: 'sealed', review: 'review', finished: 'review' })[stage];
  for (const id of ['entry', 'sealed', 'review']) {
    const element = byId(`step-${id}`);
    if (id === step) element.setAttribute('aria-current', 'step');
    else element.removeAttribute('aria-current');
  }

  bidsForm.hidden = stage !== 'entry';
  evaluationForm.hidden = stage !== 'sealed';
  byId('records').hidden = stage !== 'review' && stage !== 'finished';
  byId('decision-buttons').hidden = stage !== 'review';
  byId('show-block').hidden = stage !== 'finished';
  byId('contract').textContent = next.contract;
  renderBlocks(next.blocks, next.history);
  renderHistory(next.history);
  document.querySelector('.desk').dataset.stage = stage === 'finished'
    ? (decision === 'Award held' ? 'held' : 'awarded')
    : stage;

  const labels = {
    entry: ['Enter two bids', 'Both amounts are sealed before the evaluator can open them.'],
    sealed: ['Both bids are sealed', 'Intake now checks both openings. Choose what the evaluator includes.'],
    review: ['Proposed award', `The evaluator proposes Supplier ${proposed}. Compare the receipts before deciding.`],
    finished: [decision, 'TenderLedger recorded the reviewer’s decision on the local chain.'],
    error: ['The tender could not continue', 'Choose New tender to start again.'],
  };
  [title.textContent, detail.textContent] = labels[stage];
  byId('finding').textContent = omission
    ? `Supplier ${omission.supplier} has a confirmed intake receipt but is missing from the evaluation.`
    : 'Both intake receipts match the evaluation.';
  byId('bid-rows').replaceChildren(...bids.map(bid => {
    const row = document.createElement('tr');
    const values = [
      `Supplier ${bid.supplier}`,
      amount.format(BigInt(bid.price)),
      bid.delivered ? 'Confirmed' : 'Missing',
      bid.evaluated ? 'Included' : 'Missing',
    ];
    values.forEach((value, i) => {
      const cell = document.createElement(i === 0 ? 'th' : 'td');
      if (i === 0) cell.scope = 'row';
      if (value === 'Missing') cell.className = 'missing';
      cell.textContent = value;
      row.append(cell);
    });
    return row;
  }));
}

async function load() {
  const response = await fetch('/api/tender');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  render(data);
}

async function act(action, fields = {}) {
  if (!state || busy) return;
  setBusy(true);
  notify('Sending to the local ledger…');
  try {
    const response = await fetch('/api/tender', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, revision: state.revision, ...fields }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (response.status === 409 || response.status === 500) await load();
      throw new Error(result.error);
    }
    if (action === 'reset') {
      bidsForm.reset();
      evaluationForm.reset();
    }
    render(result);
    notify('');
    title.focus({ preventScroll: true });
  } catch (error) {
    notify(error.message === 'Failed to fetch'
      ? 'The local server is unavailable. Start it in PowerShell and refresh this page.'
      : error.message, true);
  } finally {
    setBusy(false);
  }
}

bidsForm.addEventListener('submit', event => {
  event.preventDefault();
  act('seal', Object.fromEntries(new FormData(bidsForm)));
});
evaluationForm.addEventListener('submit', event => {
  event.preventDefault();
  act('propose', { omitB: byId('omit-b').checked });
});
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => act(button.dataset.action));
}

load().catch(() => {
  title.textContent = 'Local server unavailable';
  detail.textContent = 'Start the demo in PowerShell, then reload this page.';
}).finally(() => setBusy(false));
