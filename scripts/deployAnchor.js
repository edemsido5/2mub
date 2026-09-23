const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Déploiement depuis :", deployer.address);

  const Factory = await ethers.getContractFactory("PrivateToPublicAnchor");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  // Récupération du reçu de la transaction de DÉPLOIEMENT
  const deployTx = contract.deploymentTransaction();
  const deployReceipt = await deployTx.wait();

  console.log("PrivateToPublicAnchor déployé à :", await contract.getAddress());
  console.log("Déploiement — gas utilisé :", deployReceipt.gasUsed.toString());
  console.log("Déploiement — hash de la transaction :", deployReceipt.hash);

  // Appel de anchorPrivateBlock (comme précédemment)
  const tx = await contract.anchorPrivateBlock(
    12345,
    ethers.keccak256(ethers.toUtf8Bytes("bloc-privé-test-L1"))
  );
  const receipt = await tx.wait();

  console.log("anchorPrivateBlock — gas utilisé :", receipt.gasUsed.toString());
  console.log("anchorPrivateBlock — hash de la transaction :", receipt.hash);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}); 