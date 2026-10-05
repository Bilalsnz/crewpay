// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * CrewPay — one client payment, split across a crew, with a holdback that
 * releases on acceptance or returns on deadline.
 *
 * Every settlement rule lives here. The web app reads state and sends
 * transactions; it decides nothing. If the frontend were replaced tomorrow the
 * money would still move the same way.
 *
 * The token is any TIP-20/ERC-20 with `transferFrom` — pathUSD on Tempo. Funds
 * are never held by this contract except for the holdback, and only between
 * payment and acceptance/reclaim.
 */

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

contract CrewPay {
    /* ───────────────────────────── constants ───────────────────────────── */

    /// Up to four crew wallets per job.
    uint8 public constant MAX_CREW = 4;

    /// The client holds back 10% until they accept the work.
    uint16 public constant HOLDBACK_BPS = 1000;

    /// Percentages are basis points, so they are exact integers — never floats.
    uint16 public constant BPS_DENOMINATOR = 10000;

    /// A deadline further out than this is almost certainly a typo (10 years).
    uint64 public constant MAX_DEADLINE_HORIZON = 10 * 365 days;

    /* ─────────────────────────────── state ─────────────────────────────── */

    IERC20 public immutable token;

    struct Job {
        address client; // pays, and is the only one who can accept or reclaim
        uint64 deadline; // after this, the holdback becomes returnable
        uint64 createdAt;
        uint128 total; // full invoice amount, in token units
        uint8 crewCount; // 1..4
        bool paid;
        bool accepted;
        bool returned;
        address[4] crew;
        uint16[4] shares; // basis points of the crew portion; must sum to 10000
    }

    uint256 public jobCount;

    mapping(uint256 => Job) private _jobs;

    /// jobId => the 10% currently locked. Zero once accepted or returned.
    mapping(uint256 => uint256) public holdback;

    /* ─────────────────────────────── events ────────────────────────────── */

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        uint128 total,
        uint64 deadline,
        uint8 crewCount
    );
    event JobPaid(uint256 indexed jobId, address indexed client, uint128 crewTotal, uint128 held);
    event JobAccepted(uint256 indexed jobId, uint128 released);
    event JobReturned(uint256 indexed jobId, uint128 refunded);

    /* ─────────────────────────────── errors ────────────────────────────── */

    error NoCrew();
    error TooManyCrew(uint256 given);
    error CrewLengthMismatch();
    error ZeroAddress();
    error BadShares(uint256 sum);
    error ZeroAmount();
    error DeadlineInPast();
    error DeadlineTooFar();
    error NoSuchJob(uint256 jobId);
    error AlreadyPaid(uint256 jobId);
    error NotPaid(uint256 jobId);
    error NotClient();
    error AlreadyAccepted();
    error AlreadyReturned();
    error DeadlineNotPassed();
    error DeadlinePassed();
    error TransferFailed();

    /* ───────────────────────────── constructor ─────────────────────────── */

    constructor(address token_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
    }

    /* ────────────────────────────── creating ───────────────────────────── */

    /**
     * Freezes a job — the crew, their percentages and the deadline — before the
     * client has paid anything. Nothing about it can be edited afterwards,
     * which is what makes the payment link trustworthy: the link only carries
     * the id, and this record is the authority.
     */
    function createJob(
        address[] calldata crew,
        uint16[] calldata shares,
        uint128 total,
        uint64 deadline
    ) external returns (uint256 jobId) {
        uint256 n = crew.length;
        if (n == 0) revert NoCrew();
        if (n > MAX_CREW) revert TooManyCrew(n);
        if (n != shares.length) revert CrewLengthMismatch();
        if (total == 0) revert ZeroAmount();

        if (deadline <= block.timestamp) revert DeadlineInPast();
        if (deadline > block.timestamp + MAX_DEADLINE_HORIZON) revert DeadlineTooFar();

        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (crew[i] == address(0)) revert ZeroAddress();
            sum += shares[i];
        }
        if (sum != BPS_DENOMINATOR) revert BadShares(sum);

        jobId = ++jobCount;
        Job storage j = _jobs[jobId];
        j.client = msg.sender;
        j.deadline = deadline;
        j.createdAt = uint64(block.timestamp);
        j.total = total;
        j.crewCount = uint8(n);
        for (uint256 i; i < n; ++i) {
            j.crew[i] = crew[i];
            j.shares[i] = shares[i];
        }

        emit JobCreated(jobId, msg.sender, total, deadline, uint8(n));
    }

    /* ─────────────────────────────── paying ────────────────────────────── */

    /**
     * The two-transaction path: the client approved this contract first.
     * `payWithPermit` below does the same thing in one transaction.
     */
    function pay(uint256 jobId) external {
        Job storage j = _requirePayable(jobId);
        if (!token.transferFrom(j.client, address(this), j.total)) revert TransferFailed();
        _settlePayment(jobId, j);
    }

    /**
     * The one-transaction path. The client signs an EIP-2612 permit off-chain
     * (no gas), then anybody may submit it — here the client does, so there is
     * exactly one wallet confirmation for the whole payment.
     */
    function payWithPermit(
        uint256 jobId,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Job storage j = _requirePayable(jobId);
        IERC20Permit(address(token)).permit(
            j.client,
            address(this),
            j.total,
            permitDeadline,
            v,
            r,
            s
        );
        if (!token.transferFrom(j.client, address(this), j.total)) revert TransferFailed();
        _settlePayment(jobId, j);
    }

    function _requirePayable(uint256 jobId) private view returns (Job storage j) {
        j = _jobs[jobId];
        if (j.client == address(0)) revert NoSuchJob(jobId);
        if (msg.sender != j.client) revert NotClient();
        if (j.paid) revert AlreadyPaid(jobId);
    }

    /**
     * The 90% leaves this transaction immediately, in the same call that takes
     * the money — the crew never depend on a second transaction happening.
     * Only the 10% stays behind.
     *
     * Amounts are computed so they sum to the crew total exactly: the last
     * member absorbs the rounding remainder rather than leaving dust stranded.
     */
    function _settlePayment(uint256 jobId, Job storage j) private {
        uint256 crewTotal = (uint256(j.total) * (BPS_DENOMINATOR - HOLDBACK_BPS)) / BPS_DENOMINATOR;
        uint256 held = uint256(j.total) - crewTotal;

        uint256 distributed;
        uint8 n = j.crewCount;
        for (uint8 i; i < n; ++i) {
            uint256 amount = i == n - 1
                ? crewTotal - distributed
                : (crewTotal * j.shares[i]) / BPS_DENOMINATOR;
            distributed += amount;
            if (amount > 0 && !token.transfer(j.crew[i], amount)) revert TransferFailed();
        }

        j.paid = true;
        holdback[jobId] = held;

        emit JobPaid(jobId, msg.sender, uint128(crewTotal), uint128(held));
    }

    /* ────────────────────────── accepting / returning ──────────────────── */

    /**
     * The client accepts the work: the 10% goes to the same crew, split by the
     * same percentages, in this one transaction.
     */
    function accept(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert NoSuchJob(jobId);
        if (msg.sender != j.client) revert NotClient();
        if (!j.paid) revert NotPaid(jobId);
        if (j.accepted) revert AlreadyAccepted();
        if (j.returned) revert AlreadyReturned();
        if (block.timestamp > j.deadline) revert DeadlinePassed();

        uint256 amount = holdback[jobId];
        holdback[jobId] = 0;
        j.accepted = true;

        _distributeToCrew(j, amount);
        emit JobAccepted(jobId, uint128(amount));
    }

    /**
     * The deadline passed and the client never accepted: the holdback goes back
     * to the client. Callable by anyone — the money can only ever go to the
     * client, so there is nothing to grief — which means the return does not
     * depend on the client still having the link or the keys to a funded
     * account.
     */
    function reclaim(uint256 jobId) external {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert NoSuchJob(jobId);
        if (!j.paid) revert NotPaid(jobId);
        if (j.accepted) revert AlreadyAccepted();
        if (j.returned) revert AlreadyReturned();
        if (block.timestamp <= j.deadline) revert DeadlineNotPassed();

        uint256 amount = holdback[jobId];
        holdback[jobId] = 0;
        j.returned = true;

        if (amount > 0 && !token.transfer(j.client, amount)) revert TransferFailed();
        emit JobReturned(jobId, uint128(amount));
    }

    function _distributeToCrew(Job storage j, uint256 amount) private {
        uint256 distributed;
        uint8 n = j.crewCount;
        for (uint8 i; i < n; ++i) {
            uint256 part = i == n - 1
                ? amount - distributed
                : (amount * j.shares[i]) / BPS_DENOMINATOR;
            distributed += part;
            if (part > 0 && !token.transfer(j.crew[i], part)) revert TransferFailed();
        }
    }

    /* ──────────────────────────────── views ────────────────────────────── */

    function getJob(uint256 jobId)
        external
        view
        returns (
            address client,
            uint64 deadline,
            uint64 createdAt,
            uint128 total,
            uint8 crewCount,
            bool paid,
            bool accepted,
            bool returned,
            address[4] memory crew,
            uint16[4] memory shares
        )
    {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert NoSuchJob(jobId);
        return (
            j.client,
            j.deadline,
            j.createdAt,
            j.total,
            j.crewCount,
            j.paid,
            j.accepted,
            j.returned,
            j.crew,
            j.shares
        );
    }

    /**
     * "unpaid" | "paid" | "accepted" | "returned", straight from state.
     * The UI renders this string and nothing else, so the label can never drift
     * from what the contract actually holds.
     */
    function statusOf(uint256 jobId) external view returns (string memory) {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert NoSuchJob(jobId);
        if (j.accepted) return "accepted";
        if (j.returned) return "returned";
        if (j.paid) return "paid";
        return "unpaid";
    }

    /// What each crew member receives from the 90%, in token units.
    function crewAmounts(uint256 jobId) external view returns (uint256[4] memory amounts) {
        Job storage j = _jobs[jobId];
        if (j.client == address(0)) revert NoSuchJob(jobId);
        uint256 crewTotal = (uint256(j.total) * (BPS_DENOMINATOR - HOLDBACK_BPS)) / BPS_DENOMINATOR;
        uint256 distributed;
        uint8 n = j.crewCount;
        for (uint8 i; i < n; ++i) {
            uint256 amount = i == n - 1
                ? crewTotal - distributed
                : (crewTotal * j.shares[i]) / BPS_DENOMINATOR;
            distributed += amount;
            amounts[i] = amount;
        }
    }

    /// True once the holdback can be sent back to the client instead of the crew.
    function isReturnable(uint256 jobId) external view returns (bool) {
        Job storage j = _jobs[jobId];
        return j.paid && !j.accepted && !j.returned && block.timestamp > j.deadline;
    }
}
