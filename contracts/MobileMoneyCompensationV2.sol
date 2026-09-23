// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title MobileMoneyCompensationV2
 * @notice Secure version of the 2MUB compensation contract.
 *
 * @dev Designed to remain compatible with the V5 benchmark:
 *      - Same processTransaction() signature
 *      - Same authorization model for sponsors
 *      - Same transaction recording logic
 *      - Same events used by the benchmark
 *
 * Security improvements:
 *      - Exact Solidity compiler version
 *      - Immutable regulator administrator
 *      - Explicit transaction existence mapping
 *      - Controlled guarantee withdrawal
 *      - Safe ETH transfer using call()
 *      - Address validation
 *      - Consistent naming conventions
 */
contract MobileMoneyCompensationV2 {
    // -------------------------------------------------------------------------
    // State variables
    // -------------------------------------------------------------------------

    address public immutable regulatorAdmin;

    struct SponsoringActor {
        string name;
        bool isAuthorized;
        uint256 guaranteeBalance;
    }

    struct TransactionTx {
        bytes32 reqTxHash;
        bytes32 transfTxHash;
        address senderWallet;
        address receiverWallet;
        uint256 amount;
        bool statusTx;
        uint256 timestamp;
    }

    mapping(address => SponsoringActor) public sponsors;

    mapping(bytes32 => TransactionTx) public transactions;

    /**
     * @dev Explicit existence tracking.
     *      This avoids using block.timestamp as an existence sentinel.
     */
    mapping(bytes32 => bool) public transactionExists;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event SponsorRegistered(
        address indexed sponsor,
        string name
    );

    event GuaranteeDeposited(
        address indexed sponsor,
        uint256 amount,
        uint256 newBalance
    );

    event GuaranteeWithdrawn(
        address indexed sponsor,
        uint256 amount,
        uint256 newBalance
    );

    event TransactionCleared(
        bytes32 indexed reqTxHash,
        address indexed sender,
        address indexed receiver,
        uint256 amount,
        bool statusTx
    );

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyRegulator() {
        require(
            msg.sender == regulatorAdmin,
            "MobileMoneyCompensationV2: caller is not the regulator"
        );
        _;
    }

    modifier onlyAuthorizedSponsor() {
        require(
            sponsors[msg.sender].isAuthorized,
            "MobileMoneyCompensationV2: caller is not an authorized sponsor"
        );
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor() {
        regulatorAdmin = msg.sender;
    }

    // -------------------------------------------------------------------------
    // Sponsor management
    // -------------------------------------------------------------------------

    /**
     * @notice Registers an authorized sponsoring actor.
     * @param sponsorAddress Address of the sponsor.
     * @param name Human-readable sponsor name.
     */
    function registerSponsor(
        address sponsorAddress,
        string calldata name
    ) external onlyRegulator {
        require(
            sponsorAddress != address(0),
            "MobileMoneyCompensationV2: invalid sponsor address"
        );

        require(
            sponsorAddress != regulatorAdmin,
            "MobileMoneyCompensationV2: regulator cannot be sponsor"
        );

        require(
            bytes(name).length > 0,
            "MobileMoneyCompensationV2: empty sponsor name"
        );

        require(
            !sponsors[sponsorAddress].isAuthorized,
            "MobileMoneyCompensationV2: sponsor already registered"
        );

        sponsors[sponsorAddress] = SponsoringActor({
            name: name,
            isAuthorized: true,
            guaranteeBalance: 0
        });

        emit SponsorRegistered(sponsorAddress, name);
    }

    // -------------------------------------------------------------------------
    // Guarantee management
    // -------------------------------------------------------------------------

    /**
     * @notice Deposits ETH as a guarantee for the authorized sponsor.
     *
     * @dev Kept compatible with the original contract.
     */
    function depositGuarantee()
        external
        payable
        onlyAuthorizedSponsor
    {
        require(
            msg.value > 0,
            "MobileMoneyCompensationV2: deposit must be greater than zero"
        );

        sponsors[msg.sender].guaranteeBalance += msg.value;

        emit GuaranteeDeposited(
            msg.sender,
            msg.value,
            sponsors[msg.sender].guaranteeBalance
        );
    }

    /**
     * @notice Withdraws part or all of a sponsor's guarantee.
     *
     * @dev Only the regulator can authorize a withdrawal.
     *      The accounting state is updated BEFORE the external call
     *      to prevent reentrancy-related inconsistencies.
     */
    function withdrawGuarantee(
        address payable sponsorAddress,
        uint256 amount
    ) external onlyRegulator {
        require(
            sponsorAddress != address(0),
            "MobileMoneyCompensationV2: invalid sponsor address"
        );

        require(
            sponsorAddress != regulatorAdmin,
            "MobileMoneyCompensationV2: regulator cannot withdraw sponsor funds"
        );

        require(
            sponsors[sponsorAddress].isAuthorized,
            "MobileMoneyCompensationV2: sponsor is not authorized"
        );

        require(
            amount > 0,
            "MobileMoneyCompensationV2: withdrawal must be greater than zero"
        );

        require(
            sponsors[sponsorAddress].guaranteeBalance >= amount,
            "MobileMoneyCompensationV2: insufficient guarantee balance"
        );

        // Effects before interaction.
        sponsors[sponsorAddress].guaranteeBalance -= amount;

        // Interaction.
        (bool success, ) = sponsorAddress.call{value: amount}("");

        require(
            success,
            "MobileMoneyCompensationV2: guarantee transfer failed"
        );

        emit GuaranteeWithdrawn(
            sponsorAddress,
            amount,
            sponsors[sponsorAddress].guaranteeBalance
        );
    }

    // -------------------------------------------------------------------------
    // Transaction processing
    // -------------------------------------------------------------------------

    /**
     * @notice Records a Mobile Money transaction in the compensation layer.
     *
     * @dev The function signature is intentionally preserved from the
     *      original MobileMoneyCompensation contract so that benchmark V5
     *      can call it without modification.
     *
     * @param reqTxHash Request transaction identifier.
     * @param transfTxHash Transfer transaction identifier.
     * @param senderWallet Sender wallet address.
     * @param receiverWallet Receiver wallet address.
     * @param amount Transaction amount.
     * @param statusTx Transaction status.
     */
    function processTransaction(
        bytes32 reqTxHash,
        bytes32 transfTxHash,
        address senderWallet,
        address receiverWallet,
        uint256 amount,
        bool statusTx
    )
        external
        onlyAuthorizedSponsor
        returns (bool)
    {
        require(
            !transactionExists[reqTxHash],
            "MobileMoneyCompensationV2: transaction already recorded"
        );

        require(
            reqTxHash != bytes32(0),
            "MobileMoneyCompensationV2: invalid request transaction hash"
        );

        require(
            transfTxHash != bytes32(0),
            "MobileMoneyCompensationV2: invalid transfer transaction hash"
        );

        require(
            senderWallet != address(0),
            "MobileMoneyCompensationV2: invalid sender address"
        );

        require(
            receiverWallet != address(0),
            "MobileMoneyCompensationV2: invalid receiver address"
        );

        require(
            senderWallet != receiverWallet,
            "MobileMoneyCompensationV2: sender and receiver must differ"
        );

        transactions[reqTxHash] = TransactionTx({
            reqTxHash: reqTxHash,
            transfTxHash: transfTxHash,
            senderWallet: senderWallet,
            receiverWallet: receiverWallet,
            amount: amount,
            statusTx: statusTx,
            timestamp: block.timestamp
        });

        transactionExists[reqTxHash] = true;

        emit TransactionCleared(
            reqTxHash,
            senderWallet,
            receiverWallet,
            amount,
            statusTx
        );

        return true;
    }
}