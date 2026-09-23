const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PrivateToPublicAnchor", function () {
  it("stores and retrieves an anchor by block number in O(1)", async function () {
    const Factory = await ethers.getContractFactory("PrivateToPublicAnchor");
    const contract = await Factory.deploy();
    const hash = ethers.keccak256(ethers.toUtf8Bytes("bloc-test"));

    await contract.anchorPrivateBlock(42, hash);
    const anchor = await contract.getAnchorByBlockNumber(42);

    expect(anchor.privateBlockHash).to.equal(hash);
    expect(await contract.totalAnchors()).to.equal(1);
  });

  it("rejects anchoring from a non-authorized caller", async function () {
    const [authority, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PrivateToPublicAnchor");
    const contract = await Factory.deploy();

    await expect(
      contract.connect(other).anchorPrivateBlock(1, ethers.keccak256(ethers.toUtf8Bytes("x")))
    ).to.be.revertedWith("PrivateToPublicAnchor: caller is not the anchor authority");
  });

  it("keeps getRecentAnchors bounded even after exceeding the window size", async function () {
    const Factory = await ethers.getContractFactory("PrivateToPublicAnchor");
    const contract = await Factory.deploy();
    const windowSize = await contract.RECENT_WINDOW_SIZE();

    for (let i = 0; i < Number(windowSize) + 10; i++) {
      await contract.anchorPrivateBlock(i, ethers.keccak256(ethers.toUtf8Bytes(`bloc-${i}`)));
    }

    const recent = await contract.getRecentAnchors();
    expect(recent.length).to.equal(Number(windowSize));
    expect(await contract.totalAnchors()).to.equal(Number(windowSize) + 10);
  });
});