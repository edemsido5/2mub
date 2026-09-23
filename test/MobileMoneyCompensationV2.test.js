const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MobileMoneyCompensationV2 - withdrawGuarantee", function () {
  let contract;
  let regulator;
  let sponsor;
  let other;

  beforeEach(async function () {
    [regulator, sponsor, other] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory(
      "MobileMoneyCompensationV2"
    );

    contract = await Factory.deploy();

    await contract
      .connect(regulator)
      .registerSponsor(sponsor.address, "Orange Money BF");

    await contract
      .connect(sponsor)
      .depositGuarantee({
        value: ethers.parseEther("1.0"),
      });
  });

  it("allows the regulator to withdraw part of a sponsor's guarantee", async function () {
    await expect(
      contract
        .connect(regulator)
        .withdrawGuarantee(
          sponsor.address,
          ethers.parseEther("0.4")
        )
    )
      .to.emit(contract, "GuaranteeWithdrawn")
      .withArgs(
        sponsor.address,
        ethers.parseEther("0.4"),
        ethers.parseEther("0.6")
      );

    expect(
      (await contract.sponsors(sponsor.address)).guaranteeBalance
    ).to.equal(ethers.parseEther("0.6"));
  });

  it("rejects a withdrawal exceeding the guarantee balance", async function () {
    await expect(
      contract
        .connect(regulator)
        .withdrawGuarantee(
          sponsor.address,
          ethers.parseEther("5.0")
        )
    ).to.be.revertedWith(
      "MobileMoneyCompensationV2: insufficient guarantee balance"
    );
  });

  it("rejects a withdrawal attempt from a non-regulator caller", async function () {
    await expect(
      contract
        .connect(other)
        .withdrawGuarantee(
          sponsor.address,
          ethers.parseEther("0.1")
        )
    ).to.be.revertedWith(
      "MobileMoneyCompensationV2: caller is not the regulator"
    );
  });
});