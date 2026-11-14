// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stores the audit trail of one or more synthetic sealed tenders.
contract TenderLedger {
    enum State { Missing, Open, Closed, Awarded, NoAward, Held }
    struct Tender {
        bytes32 ruleDigest;
        uint64 commitEnd;
        uint64 revealEnd;
        uint16 count;
        State state;
        address winner;
        bytes32 resultDigest;
        uint64 reviewEnd;
        uint16 deliveredCount;
        uint16 recordedCount;
    }
    struct Bid {
        bytes32 commitment;
        bytes32 receipt;
        uint16 sequence;
        bytes32 delivery;
    }

    address public immutable buyer;
    address public immutable evaluator;
    address public immutable auditor;
    address public immutable intake;
    mapping(bytes32 => Tender) public tenders;
    mapping(bytes32 => mapping(address => bool)) public eligible;
    mapping(bytes32 => mapping(address => Bid)) public bids;
    mapping(bytes32 => bytes32) public proposals;

    error Unauthorized();
    error InvalidSetup();
    error IncorrectPhase();
    error MissingBid();
    error Duplicate();
    error InvalidDigest();
    error ResultMismatch();
    error IncompleteReceipts();

    event TenderCreated(bytes32 indexed id, bytes32 ruleDigest, uint64 commitEnd, uint64 revealEnd);
    event BidCommitted(bytes32 indexed id, address indexed supplier, bytes32 commitment, uint16 sequence);
    event RevealReceiptRecorded(bytes32 indexed id, address indexed supplier, bytes32 receipt);
    event TenderClosed(bytes32 indexed id);
    event ResultProposed(bytes32 indexed id, address indexed winner, bytes32 resultDigest);
    event ResultFinalized(bytes32 indexed id, address indexed winner, bytes32 resultDigest);
    event OpeningDelivered(bytes32 indexed id, address indexed supplier, bytes32 receipt);
    event AwardHeld(bytes32 indexed id, bytes32 reason);

    constructor(address evaluator_, address auditor_, address intake_) {
        if (evaluator_ == address(0) || auditor_ == address(0) || evaluator_ == auditor_
            || evaluator_ == msg.sender || auditor_ == msg.sender) revert InvalidSetup();
        buyer = msg.sender;
        evaluator = evaluator_;
        auditor = auditor_;
        if (intake_ == address(0) || intake_ == evaluator_ || intake_ == auditor_ || intake_ == msg.sender)
            revert InvalidSetup();
        intake = intake_;
    }

    function createTender(bytes32 id, bytes32 ruleDigest, uint64 commitEnd, uint64 revealEnd, uint64 reviewEnd, address[] calldata suppliers) external {
        if (msg.sender != buyer) revert Unauthorized();
        if (id == bytes32(0) || ruleDigest == bytes32(0) || commitEnd <= block.timestamp
            || revealEnd <= commitEnd || reviewEnd <= revealEnd || suppliers.length == 0 || suppliers.length > 32)
            revert InvalidSetup();
        if (tenders[id].state != State.Missing) revert Duplicate();

        for (uint256 i = 0; i < suppliers.length; i++) {
            address supplier = suppliers[i];
            if (supplier == address(0) || supplier == buyer || supplier == evaluator || supplier == auditor || supplier == intake
                || eligible[id][supplier]) revert InvalidSetup();
            eligible[id][supplier] = true;
        }
        tenders[id] = Tender(ruleDigest, commitEnd, revealEnd, 0, State.Open, address(0), bytes32(0), reviewEnd, 0, 0);
        emit TenderCreated(id, ruleDigest, commitEnd, revealEnd);
    }

    function commitBid(bytes32 id, bytes32 commitment) external {
        Tender storage tender = tenders[id];
        if (!eligible[id][msg.sender]) revert Unauthorized();
        if (tender.state != State.Open || block.timestamp >= tender.commitEnd) revert IncorrectPhase();
        if (commitment == bytes32(0)) revert InvalidDigest();
        if (bids[id][msg.sender].commitment != bytes32(0)) revert Duplicate();
        uint16 sequence = ++tender.count;
        bids[id][msg.sender] = Bid(commitment, bytes32(0), sequence, bytes32(0));
        emit BidCommitted(id, msg.sender, commitment, sequence);
    }

    function attestDelivery(bytes32 id, address supplier, bytes32 receipt) external {
        if (msg.sender != intake) revert Unauthorized();
        Tender storage tender = tenders[id];
        if (tender.state != State.Open || block.timestamp < tender.commitEnd
            || block.timestamp >= tender.revealEnd) revert IncorrectPhase();
        Bid storage bid = bids[id][supplier];
        if (bid.commitment == bytes32(0)) revert MissingBid();
        if (bid.delivery != bytes32(0)) revert Duplicate();
        if (receipt == bytes32(0)) revert InvalidDigest();
        bid.delivery = receipt;
        ++tender.deliveredCount;
        emit OpeningDelivered(id, supplier, receipt);
    }

    function recordRevealReceipt(bytes32 id, address supplier, bytes32 receipt) external {
        if (msg.sender != evaluator) revert Unauthorized();
        Tender storage tender = tenders[id];
        if (tender.state != State.Open || block.timestamp < tender.commitEnd
            || block.timestamp >= tender.revealEnd) revert IncorrectPhase();
        Bid storage bid = bids[id][supplier];
        if (bid.delivery == bytes32(0)) revert MissingBid();
        if (bid.receipt != bytes32(0)) revert Duplicate();
        if (receipt != bid.delivery) revert ResultMismatch();
        bid.receipt = receipt;
        ++tender.recordedCount;
        emit RevealReceiptRecorded(id, supplier, receipt);
    }

    function closeTender(bytes32 id) external {
        Tender storage tender = tenders[id];
        if (tender.state != State.Open || block.timestamp < tender.revealEnd) revert IncorrectPhase();
        tender.state = State.Closed;
        emit TenderClosed(id);
    }

    function proposeResult(bytes32 id, address winner, bytes32 resultDigest) external {
        if (msg.sender != evaluator) revert Unauthorized();
        Tender storage tender = tenders[id];
        if (tender.state != State.Closed || block.timestamp >= tender.reviewEnd) revert IncorrectPhase();
        if (resultDigest == bytes32(0)) revert InvalidDigest();
        if (winner != address(0) && bids[id][winner].receipt == bytes32(0)) revert MissingBid();
        proposals[id] = keccak256(abi.encode(winner, resultDigest));
        emit ResultProposed(id, winner, resultDigest);
    }

    function finalizeResult(bytes32 id, address winner, bytes32 resultDigest) external {
        if (msg.sender != auditor) revert Unauthorized();
        Tender storage tender = tenders[id];
        if (tender.state != State.Closed || block.timestamp >= tender.reviewEnd) revert IncorrectPhase();
        if (tender.deliveredCount != tender.recordedCount) revert IncompleteReceipts();
        if (proposals[id] != keccak256(abi.encode(winner, resultDigest))) revert ResultMismatch();
        tender.winner = winner;
        tender.resultDigest = resultDigest;
        tender.state = winner == address(0) ? State.NoAward : State.Awarded;
        emit ResultFinalized(id, winner, resultDigest);
    }

    function holdAward(bytes32 id, bytes32 reason) external {
        if (msg.sender != auditor) revert Unauthorized();
        if (reason == bytes32(0)) revert InvalidDigest();
        Tender storage tender = tenders[id];
        if (tender.state != State.Closed) revert IncorrectPhase();
        tender.state = State.Held;
        emit AwardHeld(id, reason);
    }

    function expireReview(bytes32 id) external {
        Tender storage tender = tenders[id];
        if (tender.state != State.Closed || block.timestamp < tender.reviewEnd) revert IncorrectPhase();
        tender.state = State.Held;
        emit AwardHeld(id, keccak256("Review deadline elapsed"));
    }
}
