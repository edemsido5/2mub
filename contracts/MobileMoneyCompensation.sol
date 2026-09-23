// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MobileMoneyCompensation {
    address public regulatorAdmin;

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

    event SponsorRegistered(address indexed sponsor, string name);
    event GuaranteeDeposited(address indexed sponsor, uint256 amount, uint256 newBalance);
    event TransactionCleared(bytes32 indexed reqTxHash, address indexed sender, address indexed receiver, uint256 amount, bool statusTx);

    modifier onlyRegulator() {
        require(msg.sender == regulatorAdmin, "MobileMoneyCompensation: caller is not the regulator");
        _;
    }

    modifier onlyAuthorizedSponsor() {
        require(sponsors[msg.sender].isAuthorized, "MobileMoneyCompensation: caller is not an authorized sponsor");
        _;
    }

    constructor() {
        regulatorAdmin = msg.sender;
    }

    /// @notice Enregistre un nouvel acteur parrain (MNO, banque, IMF). Réservé au régulateur.
    function registerSponsor(address _sponsorAddress, string calldata _name) external onlyRegulator {
        require(_sponsorAddress != address(0), "MobileMoneyCompensation: invalid sponsor address");
        require(!sponsors[_sponsorAddress].isAuthorized, "MobileMoneyCompensation: sponsor already registered");
        sponsors[_sponsorAddress] = SponsoringActor({ name: _name, isAuthorized: true, guaranteeBalance: 0 });
        emit SponsorRegistered(_sponsorAddress, _name);
    }

    /// @notice Dépôt de la garantie de compensation par un sponsor autorisé.
    function depositGuarantee() external payable onlyAuthorizedSponsor {
        require(msg.value > 0, "MobileMoneyCompensation: deposit must be greater than zero");
        sponsors[msg.sender].guaranteeBalance += msg.value;
        emit GuaranteeDeposited(msg.sender, msg.value, sponsors[msg.sender].guaranteeBalance);
    }

    /// @notice Enregistre le règlement d'une transaction inter-opérateurs. Corrige la faille S-2/D-2
    /// (absence de contrôle d'accès) identifiée dans la revue de code précédente.
    function processTransaction(
        bytes32 _reqTxHash,
        bytes32 _transfTxHash,
        address _sender,
        address _receiver,
        uint256 _amount,
        bool _statusTx
    ) external onlyAuthorizedSponsor returns (bool) {
        require(transactions[_reqTxHash].timestamp == 0, "MobileMoneyCompensation: transaction already recorded");
        transactions[_reqTxHash] = TransactionTx(_reqTxHash, _transfTxHash, _sender, _receiver, _amount, _statusTx, block.timestamp);
        emit TransactionCleared(_reqTxHash, _sender, _receiver, _amount, _statusTx);
        return true;
    }
}