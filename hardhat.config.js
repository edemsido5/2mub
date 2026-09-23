require("@nomicfoundation/hardhat-toolbox");
require("hardhat-gas-reporter");
require("dotenv").config();

const benchmarkMode = process.env.BENCHMARK_MODE === "true";

module.exports = {
  solidity: "0.8.28",

  gasReporter: {
    enabled: true,
    currency: "USD",
    outputFile: "gas-report.txt",
    noColors: true
  },

  networks: {
    hardhat: {
      mining: benchmarkMode
        ? {
            auto: false,
            interval: 2000
          }
        : {
            auto: true
          },

      blockGasLimit: 60000000,

      accounts: {
        count: 50
      }
    },

    sepolia: {
      url: process.env.SEPOLIA_RPC_URL,
      accounts: [process.env.SEPOLIA_PRIVATE_KEY]
    }
  }
};