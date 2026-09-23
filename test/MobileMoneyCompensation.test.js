
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MobileMoneyCompensation", function () {
  let contract, regulator, sponsor, other;

  beforeEach(async function () {
    [regulator, sponsor, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("MobileMoneyCompensation");
    contract = await Factory.deploy();
  
  });

  it("registers a sponsor and reports gas", async function () {
    const tx = await contract.connect(regulator).registerSponsor(sponsor.address, "Orange Money BF");
    await tx.wait();
    expect((await contract.sponsors(sponsor.address)).isAuthorized).to.equal(true);
  });

  it("rejects processTransaction from a non-authorized caller", async function () {
    await expect(
      contract.connect(other).processTransaction(ethers.encodeBytes32String("req1"), ethers.encodeBytes32String("tx1"), sponsor.address, other.address, 40000, true)
    ).to.be.revertedWith("MobileMoneyCompensation: caller is not an authorized sponsor");
  });

  it("processes a successful and a failed transaction", async function () {
    await contract.connect(regulator).registerSponsor(sponsor.address, "Orange Money BF");
    await contract.connect(sponsor).processTransaction(ethers.encodeBytes32String("req-ok"), ethers.encodeBytes32String("tx-ok"), sponsor.address, other.address, 40000, true);
    await contract.connect(sponsor).processTransaction(ethers.encodeBytes32String("req-ko"), ethers.encodeBytes32String("tx-ko"), sponsor.address, other.address, 40000, false);
  });

  // --- Tests ajoutés ---

  it("rejects depositGuarantee from a non-authorized caller", async function () {
    await expect(
      contract.connect(other).depositGuarantee({ value: ethers.parseEther("1.0") })
    ).to.be.revertedWith("MobileMoneyCompensation: caller is not an authorized sponsor");
  });

  it("rejects a zero-value deposit from an authorized sponsor", async function () {
    await contract.connect(regulator).registerSponsor(sponsor.address, "Orange Money BF");
    await expect(
      contract.connect(sponsor).depositGuarantee({ value: 0 })
    ).to.be.revertedWith("MobileMoneyCompensation: deposit must be greater than zero");
  });

  it("accepts a guarantee deposit and updates the sponsor balance (gas measured here)", async function () {
    await contract.connect(regulator).registerSponsor(sponsor.address, "Orange Money BF");
    const depositAmount = ethers.parseEther("1.0");

    await expect(contract.connect(sponsor).depositGuarantee({ value: depositAmount }))
      .to.emit(contract, "GuaranteeDeposited")
      .withArgs(sponsor.address, depositAmount, depositAmount);

    expect((await contract.sponsors(sponsor.address)).guaranteeBalance).to.equal(depositAmount);
  });

  it("accumulates guarantee balance across multiple deposits", async function () {
    await contract.connect(regulator).registerSponsor(sponsor.address, "Orange Money BF");
    await contract.connect(sponsor).depositGuarantee({ value: ethers.parseEther("1.0") });
    await contract.connect(sponsor).depositGuarantee({ value: ethers.parseEther("0.5") });

    expect((await contract.sponsors(sponsor.address)).guaranteeBalance).to.equal(ethers.parseEther("1.5"));
  });
});