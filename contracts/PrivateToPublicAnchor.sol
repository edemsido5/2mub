// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PrivateToPublicAnchor {
    address public anchorAuthority;

    /// @notice Taille de la fenêtre circulaire d'ancrages récents conservée en lecture rapide.
    uint256 public constant RECENT_WINDOW_SIZE = 500;

    struct BlockAnchor {
        uint256 privateBlockNumber;
        bytes32 privateBlockHash;
        uint256 anchorTimestamp;
    }

    /// @notice Historique complet, indexé par numéro de bloc privé — recherche O(1),
    /// jamais itéré, donc sans risque de DoS par croissance de gaz (corrige SWC-113/D-1).
    mapping(uint256 => BlockAnchor) public anchorsByBlockNumber;

    /// @notice Fenêtre circulaire de taille fixe pour un accès rapide aux N derniers ancrages.
    BlockAnchor[RECENT_WINDOW_SIZE] private recentAnchors;
    uint256 private recentCursor;
    uint256 public totalAnchors;

    event BlockAnchored(uint256 indexed privateBlockNumber, bytes32 privateBlockHash, uint256 anchorTimestamp);

    modifier onlyAnchorAuthority() {
        require(msg.sender == anchorAuthority, "PrivateToPublicAnchor: caller is not the anchor authority");
        _;
    }

    constructor() {
        anchorAuthority = msg.sender;
    }

    function anchorPrivateBlock(uint256 _blockNum, bytes32 _blockHash) external onlyAnchorAuthority {
        BlockAnchor memory newAnchor = BlockAnchor(_blockNum, _blockHash, block.timestamp);

        // Historique complet : coût constant par écriture, aucune itération requise à la lecture.
        anchorsByBlockNumber[_blockNum] = newAnchor;

        // Fenêtre circulaire : taille bornée, écrase l'entrée la plus ancienne.
        recentAnchors[recentCursor] = newAnchor;
        recentCursor = (recentCursor + 1) % RECENT_WINDOW_SIZE;
        totalAnchors += 1;

        emit BlockAnchored(_blockNum, _blockHash, block.timestamp);
    }

    /// @notice Recherche O(1) d'un ancrage par numéro de bloc privé, quelle que soit
    /// l'ancienneté de l'historique total.
    function getAnchorByBlockNumber(uint256 _blockNum) external view returns (BlockAnchor memory) {
        return anchorsByBlockNumber[_blockNum];
    }

    /// @notice Retourne les RECENT_WINDOW_SIZE derniers ancrages (ou moins si l'historique
    /// total est inférieur à la taille de la fenêtre), dans l'ordre chronologique.
    function getRecentAnchors() external view returns (BlockAnchor[] memory) {
        uint256 count = totalAnchors < RECENT_WINDOW_SIZE ? totalAnchors : RECENT_WINDOW_SIZE;
        BlockAnchor[] memory result = new BlockAnchor[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 idx = (recentCursor + RECENT_WINDOW_SIZE - count + i) % RECENT_WINDOW_SIZE;
            result[i] = recentAnchors[idx];
        }
        return result;
    }

    function getAnchorCount() external view returns (uint256) {
        return totalAnchors;
    }
}