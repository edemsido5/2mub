const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// ============================================================
// 2MUB V2 - PERFORMANCE BENCHMARK
// MobileMoneyCompensationV2
// ============================================================

// -------------------------
// Configuration
// -------------------------
const TARGET_TPS = Number(process.env.TARGET_TPS || 10);
const DURATION_SEC = Number(process.env.DURATION_SEC || 30);

const MAX_SPONSORS = Number(process.env.MAX_SPONSORS || 20);
const MAX_SUBMIT_IN_FLIGHT = Number(
  process.env.MAX_SUBMIT_IN_FLIGHT || 100
);

const TX_TIMEOUT_SEC = Number(process.env.TX_TIMEOUT_SEC || 120);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 200);
const NONCE_RETRIES = Number(process.env.NONCE_RETRIES || 3);

const GAS_LIMIT = Number(process.env.GAS_LIMIT || 250000);
const TEST_AMOUNT = hre.ethers.parseEther(
  process.env.TEST_AMOUNT || "0.001"
);

// ============================================================
// Utilitaires
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, p) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);

  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  return (
    sorted[lower] +
    (sorted[upper] - sorted[lower]) * (index - lower)
  );
}

function round(value, decimals = 2) {
  return Number(value.toFixed(decimals));
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(3)} s`;
}

function nowMs() {
  return Date.now();
}

// ============================================================
// Génération déterministe de hashes
// ============================================================

function makeHash(prefix, index) {
  return hre.ethers.keccak256(
    hre.ethers.toUtf8Bytes(`${prefix}-${index}-${Date.now()}-${Math.random()}`)
  );
}

// ============================================================
// Sélection sécurisée Sender / Receiver
// IMPORTANT : sender !== receiver
// ============================================================

function selectSenderReceiver(sponsors, txIndex) {
  const count = sponsors.length;

  if (count < 2) {
    throw new Error(
      "Au moins deux sponsors sont nécessaires."
    );
  }

  const senderIndex = txIndex % count;
  const receiverIndex = (senderIndex + 1) % count;

  if (senderIndex === receiverIndex) {
    throw new Error(
      `Erreur interne : senderIndex == receiverIndex pour tx ${txIndex}`
    );
  }

  return {
    sender: sponsors[senderIndex],
    receiver: sponsors[receiverIndex],
    senderIndex,
    receiverIndex,
  };
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("");
  console.log("=================================================");
  console.log("2MUB V2 - PERFORMANCE BENCHMARK");
  console.log("MobileMoneyCompensationV2");
  console.log("=================================================");
  console.log("");

  console.log(`Target TPS              : ${TARGET_TPS}`);
  console.log(`Duration                : ${DURATION_SEC}s`);
  console.log(`Max sponsors            : ${MAX_SPONSORS}`);
  console.log(`Max submit in-flight    : ${MAX_SUBMIT_IN_FLIGHT}`);
  console.log(`Transaction timeout     : ${TX_TIMEOUT_SEC}s`);
  console.log(`Polling interval        : ${POLL_INTERVAL_MS}ms`);
  console.log(`Nonce retries           : ${NONCE_RETRIES}`);
  console.log(`Gas limit               : ${GAS_LIMIT}`);
  console.log("");

  if (TARGET_TPS <= 0) {
    throw new Error("TARGET_TPS doit être > 0");
  }

  if (DURATION_SEC <= 0) {
    throw new Error("DURATION_SEC doit être > 0");
  }

  if (MAX_SUBMIT_IN_FLIGHT <= 0) {
    throw new Error("MAX_SUBMIT_IN_FLIGHT doit être > 0");
  }

  // ==========================================================
  // Signers
  // ==========================================================

  const signers = await hre.ethers.getSigners();

  if (signers.length < MAX_SPONSORS + 1) {
    throw new Error(
      `Nombre de comptes insuffisant. ` +
        `Requis: ${MAX_SPONSORS + 1}, disponibles: ${signers.length}`
    );
  }

  const regulator = signers[0];

  const sponsors = signers.slice(1, MAX_SPONSORS + 1);

  // ==========================================================
  // [1/7] Déploiement
  // ==========================================================

  console.log("[1/7] Deploying MobileMoneyCompensationV2...");

  const ContractFactory = await hre.ethers.getContractFactory(
    "MobileMoneyCompensationV2",
    regulator
  );

  const contract = await ContractFactory.deploy();

  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();

  console.log(`Contract deployed at: ${contractAddress}`);
  console.log("");

  // ==========================================================
  // [2/7] Enregistrement des sponsors
  // ==========================================================

  console.log("[2/7] Registering sponsors...");

  for (let i = 0; i < sponsors.length; i++) {
    const sponsor = sponsors[i];
    const address = await sponsor.getAddress();
    const name = `Sponsor-${i + 1}`;

    const tx = await contract
      .connect(regulator)
      .registerSponsor(address, name);

    await tx.wait();

    console.log(`  Registered ${name}: ${address}`);
  }

  console.log("");

  // ==========================================================
  // [3/7] Configuration des frais
  // ==========================================================

  console.log("[3/7] Reading network fee configuration...");

  const feeData = await hre.ethers.provider.getFeeData();

  let gasPrice;

  if (feeData.gasPrice) {
    gasPrice = feeData.gasPrice;
  } else {
    gasPrice = hre.ethers.parseUnits("1", "gwei");
  }

  console.log(`Gas price: ${gasPrice.toString()}`);
  console.log("");

  // ==========================================================
  // [4/7] Initialisation des nonces
  // ==========================================================

  console.log("[4/7] Initializing sponsor nonces...");

  const sponsorStates = [];

  for (let i = 0; i < sponsors.length; i++) {
    const signer = sponsors[i];
    const address = await signer.getAddress();

    const nonce = await hre.ethers.provider.getTransactionCount(
      address,
      "latest"
    );

    sponsorStates.push({
      signer,
      address,
      nonce,
      lock: Promise.resolve(),
    });

    console.log(`  ${address} -> nonce ${nonce}`);
  }

  console.log("");

  // ==========================================================
  // [5/7] Préparation du workload
  // ==========================================================

  const totalTransactions = Math.round(
    TARGET_TPS * DURATION_SEC
  );

  console.log("[5/7] Preparing workload...");
  console.log(`Total transactions: ${totalTransactions}`);
  console.log("");

  // ==========================================================
  // Structures de résultats
  // ==========================================================

  const transactions = [];

  let submittedCount = 0;
  let confirmedCount = 0;
  let failedCount = 0;

  let rpcErrors = 0;
  let nonceErrors = 0;
  let timeoutErrors = 0;

  let activeSubmissions = 0;
  let observedMaxSubmit = 0;

  const submissionPromises = [];

  // ==========================================================
  // Contrôle de concurrence
  // ==========================================================

  async function waitForSubmissionSlot() {
    while (activeSubmissions >= MAX_SUBMIT_IN_FLIGHT) {
      await sleep(1);
    }
  }

  // ==========================================================
  // Envoi sérialisé par sponsor
  // ==========================================================

  async function submitTransaction(
    txIndex,
    senderState,
    receiverState
  ) {
    await waitForSubmissionSlot();

    activeSubmissions++;

    observedMaxSubmit = Math.max(
      observedMaxSubmit,
      activeSubmissions
    );

    const record = {
      index: txIndex,
      sender: senderState.address,
      receiver: receiverState.address,
      submitted: false,
      confirmed: false,
      failed: false,
      txHash: null,
      blockNumber: null,
      gasUsed: null,
      submittedAt: null,
      confirmedAt: null,
      latencyMs: null,
      error: null,
    };

    transactions.push(record);

    try {
      // ------------------------------------------------------
      // Vérification de sécurité du workload
      // ------------------------------------------------------

      if (senderState.address.toLowerCase() === receiverState.address.toLowerCase()) {
        throw new Error(
          "Benchmark error: sender and receiver must be different"
        );
      }

      // ------------------------------------------------------
      // Nonce manuel
      // ------------------------------------------------------

      const nonce = senderState.nonce++;

      const reqTxHash = makeHash("2MUB-REQ", txIndex);

      const transfTxHash = makeHash("2MUB-TRANSFER", txIndex);

      // ------------------------------------------------------
      // Création de la transaction
      // ------------------------------------------------------

      let tx;

      let attempt = 0;

      while (true) {
        try {
          tx = await contract
            .connect(senderState.signer)
            .processTransaction(
              reqTxHash,
              transfTxHash,
              senderState.address,
              receiverState.address,
              TEST_AMOUNT,
              true,
              {
                nonce,
                gasLimit: GAS_LIMIT,
                gasPrice,
              }
            );

          break;
        } catch (error) {
          attempt++;

          const message =
            error?.shortMessage ||
            error?.reason ||
            error?.message ||
            String(error);

          const lower = message.toLowerCase();

          if (
            lower.includes("nonce") ||
            lower.includes("replacement")
          ) {
            nonceErrors++;

            if (attempt <= NONCE_RETRIES) {
              console.log(
                `Nonce retry #${attempt} for transaction #${txIndex}`
              );

              await sleep(100 * attempt);

              // Relecture du nonce si nécessaire.
              const refreshedNonce =
                await hre.ethers.provider.getTransactionCount(
                  senderState.address,
                  "latest"
                );

              if (refreshedNonce > senderState.nonce) {
                senderState.nonce = refreshedNonce + 1;
              }

              continue;
            }
          }

          if (
            lower.includes("timeout") ||
            lower.includes("timed out")
          ) {
            timeoutErrors++;
          } else {
            rpcErrors++;
          }

          throw error;
        }
      }

      record.txHash = tx.hash;
      record.submitted = true;
      record.submittedAt = nowMs();

      submittedCount++;

      // ------------------------------------------------------
      // Attente de confirmation avec timeout
      // ------------------------------------------------------

      const startWait = nowMs();

      let receipt = null;

      while (
        nowMs() - startWait <
        TX_TIMEOUT_SEC * 1000
      ) {
        try {
          receipt =
            await hre.ethers.provider.getTransactionReceipt(
              tx.hash
            );

          if (receipt) {
            break;
          }
        } catch (error) {
          rpcErrors++;
        }

        await sleep(POLL_INTERVAL_MS);
      }

      if (!receipt) {
        timeoutErrors++;

        record.failed = true;
        record.error = "Transaction confirmation timeout";

        return;
      }

      // ------------------------------------------------------
      // Confirmation
      // ------------------------------------------------------

      record.confirmed = true;
      record.confirmedAt = nowMs();

      record.blockNumber = receipt.blockNumber;

      if (receipt.gasUsed) {
        record.gasUsed = Number(receipt.gasUsed);
      }

      record.latencyMs =
        record.confirmedAt - record.submittedAt;

      confirmedCount++;
    } catch (error) {
      failedCount++;

      record.failed = true;

      const message =
        error?.shortMessage ||
        error?.reason ||
        error?.message ||
        String(error);

      record.error = message;

      if (
        message.toLowerCase().includes("sender and receiver")
      ) {
        console.error(
          `CRITICAL benchmark error #${txIndex}: ${message}`
        );
      }
    } finally {
      activeSubmissions--;
    }
  }

  // ==========================================================
  // [6/7] Génération open-loop
  // ==========================================================

  console.log("[6/7] Starting open-loop workload...");
  console.log("");

  const generationStart = nowMs();

  const intervalMs = 1000 / TARGET_TPS;

  let nextSubmissionTime = generationStart;

  for (let i = 0; i < totalTransactions; i++) {
    // --------------------------------------------------------
    // Respect du débit cible
    // --------------------------------------------------------

    const now = nowMs();

    if (nextSubmissionTime > now) {
      await sleep(nextSubmissionTime - now);
    }

    // --------------------------------------------------------
    // Sélection déterministe sender / receiver
    // --------------------------------------------------------

    const {
      senderIndex,
      receiverIndex,
    } = selectSenderReceiver(sponsors, i);

    const senderState =
      sponsorStates[senderIndex];

    const receiverState =
      sponsorStates[receiverIndex];

    // --------------------------------------------------------
    // IMPORTANT :
    // On ne bloque pas la génération sur la confirmation.
    // --------------------------------------------------------

    const promise = submitTransaction(
      i + 1,
      senderState,
      receiverState
    );

    submissionPromises.push(promise);

    nextSubmissionTime += intervalMs;

    // --------------------------------------------------------
    // Protection contre une dérive temporelle
    // --------------------------------------------------------

    if (nextSubmissionTime < nowMs()) {
      nextSubmissionTime = nowMs();
    }
  }

  const generationEnd = nowMs();

  const generationDuration =
    generationEnd - generationStart;

  console.log("Generation completed.");
  console.log(
    `Generation duration : ${formatSeconds(
      generationDuration
    )}`
  );

  // Attendre que toutes les soumissions aient terminé.
  await Promise.all(submissionPromises);

  const actualSubmittedCount = submittedCount;

  const offeredTPS =
    totalTransactions /
    (generationDuration / 1000);

  console.log(
    `Offered TPS          : ${offeredTPS.toFixed(2)}`
  );

  console.log(
    `Submitted            : ${actualSubmittedCount}/${totalTransactions}`
  );

  console.log("");

  // ==========================================================
  // [7/7] Confirmation / drainage
  // ==========================================================

  console.log("[7/7] Waiting for confirmations...");
  console.log("");

  // Les confirmations ont déjà été suivies pendant les envois.
  // Ici on vérifie si certaines transactions sont encore en attente.

  const confirmationWaitStart = nowMs();

  while (
    transactions.some(
      (t) =>
        t.submitted &&
        !t.confirmed &&
        !t.failed
    )
  ) {
    if (
      nowMs() - confirmationWaitStart >
      TX_TIMEOUT_SEC * 1000
    ) {
      for (const record of transactions) {
        if (
          record.submitted &&
          !record.confirmed &&
          !record.failed
        ) {
          record.failed = true;
          record.error = "Global confirmation timeout";
          timeoutErrors++;
          failedCount++;
        }
      }

      break;
    }

    await sleep(POLL_INTERVAL_MS);

    for (const record of transactions) {
      if (
        record.submitted &&
        !record.confirmed &&
        !record.failed &&
        record.txHash
      ) {
        try {
          const receipt =
            await hre.ethers.provider.getTransactionReceipt(
              record.txHash
            );

          if (receipt) {
            record.confirmed = true;
            record.confirmedAt = nowMs();

            record.blockNumber =
              receipt.blockNumber;

            if (receipt.gasUsed) {
              record.gasUsed = Number(
                receipt.gasUsed
              );
            }

            if (record.submittedAt) {
              record.latencyMs =
                record.confirmedAt -
                record.submittedAt;
            }

            confirmedCount++;
          }
        } catch (error) {
          rpcErrors++;
        }
      }
    }
  }

  const endTime = nowMs();

  // ==========================================================
  // Calculs
  // ==========================================================

  const successfulTransactions =
    transactions.filter(
      (t) => t.confirmed && t.latencyMs !== null
    );

  const latencies =
    successfulTransactions.map(
      (t) => t.latencyMs
    );

  const gasValues =
    successfulTransactions
      .filter((t) => t.gasUsed !== null)
      .map((t) => t.gasUsed);

  // ----------------------------------------------------------
  // Drain
  // ----------------------------------------------------------

  const drainDuration =
    Math.max(
      0,
      endTime - generationEnd
    );

  const totalDuration =
    endTime - generationStart;

  const confirmedTPS =
    confirmedCount /
    (totalDuration / 1000);

  let drainTPS = 0;

  if (drainDuration > 0 && confirmedCount > 0) {
    drainTPS =
      confirmedCount /
      (drainDuration / 1000);
  }

  const successRate =
    totalTransactions > 0
      ? (confirmedCount / totalTransactions) * 100
      : 0;

  // ----------------------------------------------------------
  // Latence
  // ----------------------------------------------------------

  const minLatency =
    latencies.length
      ? Math.min(...latencies)
      : 0;

  const maxLatency =
    latencies.length
      ? Math.max(...latencies)
      : 0;

  const avgLatency =
    latencies.length
      ? latencies.reduce(
          (sum, value) => sum + value,
          0
        ) / latencies.length
      : 0;

  const p50 =
    percentile(latencies, 50);

  const p95 =
    percentile(latencies, 95);

  const p99 =
    percentile(latencies, 99);

  // ----------------------------------------------------------
  // Gas
  // ----------------------------------------------------------

  const minGas =
    gasValues.length
      ? Math.min(...gasValues)
      : 0;

  const maxGas =
    gasValues.length
      ? Math.max(...gasValues)
      : 0;

  const avgGas =
    gasValues.length
      ? gasValues.reduce(
          (sum, value) => sum + value,
          0
        ) / gasValues.length
      : 0;

  // ----------------------------------------------------------
  // Blocs
  // ----------------------------------------------------------

  const blockNumbers = [
    ...new Set(
      successfulTransactions
        .map((t) => t.blockNumber)
        .filter(
          (block) => block !== null
        )
    ),
  ];

  const blocksUsed =
    blockNumbers.length;

  const txPerBlock =
    blocksUsed > 0
      ? confirmedCount / blocksUsed
      : 0;

  // ==========================================================
  // Résultats
  // ==========================================================

  console.log("=================================================");
  console.log("2MUB V2 BENCHMARK RESULTS");
  console.log("=================================================");

  console.log(
    `Target TPS              : ${TARGET_TPS}`
  );

  console.log(
    `Duration                : ${DURATION_SEC}s`
  );

  console.log(
    `Total transactions      : ${totalTransactions}`
  );

  console.log(
    `Offered TPS             : ${offeredTPS.toFixed(2)}`
  );

  console.log(
    `Submitted               : ${submittedCount}`
  );

  console.log(
    `Confirmed               : ${confirmedCount}`
  );

  console.log(
    `Failed                  : ${failedCount}`
  );

  console.log(
    `Success rate            : ${successRate.toFixed(
      2
    )} %`
  );

  console.log(
    `Confirmed TPS           : ${confirmedTPS.toFixed(
      2
    )}`
  );

  console.log(
    `Drain TPS               : ${drainTPS.toFixed(
      2
    )}`
  );

  console.log(
    `Generation duration     : ${formatSeconds(
      generationDuration
    )}`
  );

  console.log(
    `Drain duration          : ${formatSeconds(
      drainDuration
    )}`
  );

  console.log(
    `Total duration          : ${formatSeconds(
      totalDuration
    )}`
  );

  console.log("");

  console.log("LATENCY");

  console.log(
    `Min                     : ${minLatency.toFixed(
      2
    )} ms`
  );

  console.log(
    `P50                     : ${p50.toFixed(
      2
    )} ms`
  );

  console.log(
    `Average                 : ${avgLatency.toFixed(
      2
    )} ms`
  );

  console.log(
    `P95                     : ${p95.toFixed(
      2
    )} ms`
  );

  console.log(
    `P99                     : ${p99.toFixed(
      2
    )} ms`
  );

  console.log(
    `Max                     : ${maxLatency.toFixed(
      2
    )} ms`
  );

  console.log("");

  console.log("GAS");

  console.log(
    `Min                     : ${minGas.toFixed(
      2
    )}`
  );

  console.log(
    `Average                 : ${avgGas.toFixed(
      2
    )}`
  );

  console.log(
    `Max                     : ${maxGas.toFixed(
      2
    )}`
  );

  console.log("");

  console.log("BLOCKS");

  console.log(
    `Blocks used             : ${blocksUsed}`
  );

  console.log(
    `Transactions/block      : ${txPerBlock.toFixed(
      2
    )}`
  );

  console.log("");

  console.log("ERRORS");

  console.log(
    `RPC errors              : ${rpcErrors}`
  );

  console.log(
    `Nonce errors            : ${nonceErrors}`
  );

  console.log(
    `Timeouts                : ${timeoutErrors}`
  );

  console.log("");

  console.log("CONCURRENCY");

  console.log(
    `Configured max submit   : ${MAX_SUBMIT_IN_FLIGHT}`
  );

  console.log(
    `Observed max submit     : ${observedMaxSubmit}`
  );

  console.log("");

  console.log(
    `Contract address        : ${contractAddress}`
  );

  console.log("=================================================");
  console.log("");

  // ==========================================================
  // CSV global
  // ==========================================================

  const globalCsvName =
    `benchmark-v2-${TARGET_TPS}TPS.csv`;

  const globalCsvPath =
    path.join(process.cwd(), globalCsvName);

  const globalHeader = [
    "target_tps",
    "duration_sec",
    "total_transactions",
    "offered_tps",
    "submitted",
    "confirmed",
    "failed",
    "success_rate_percent",
    "confirmed_tps",
    "drain_tps",
    "generation_duration_sec",
    "drain_duration_sec",
    "total_duration_sec",
    "latency_min_ms",
    "latency_p50_ms",
    "latency_avg_ms",
    "latency_p95_ms",
    "latency_p99_ms",
    "latency_max_ms",
    "gas_min",
    "gas_avg",
    "gas_max",
    "blocks_used",
    "transactions_per_block",
    "rpc_errors",
    "nonce_errors",
    "timeouts",
    "configured_max_submit",
    "observed_max_submit",
    "contract_address",
  ];

  const globalRow = [
    TARGET_TPS,
    DURATION_SEC,
    totalTransactions,
    round(offeredTPS, 4),
    submittedCount,
    confirmedCount,
    failedCount,
    round(successRate, 4),
    round(confirmedTPS, 4),
    round(drainTPS, 4),
    round(generationDuration / 1000, 4),
    round(drainDuration / 1000, 4),
    round(totalDuration / 1000, 4),
    round(minLatency, 4),
    round(p50, 4),
    round(avgLatency, 4),
    round(p95, 4),
    round(p99, 4),
    round(maxLatency, 4),
    round(minGas, 4),
    round(avgGas, 4),
    round(maxGas, 4),
    blocksUsed,
    round(txPerBlock, 4),
    rpcErrors,
    nonceErrors,
    timeoutErrors,
    MAX_SUBMIT_IN_FLIGHT,
    observedMaxSubmit,
    contractAddress,
  ];

  fs.writeFileSync(
    globalCsvPath,
    globalHeader.join(",") +
      "\n" +
      globalRow.join(",") +
      "\n",
    "utf8"
  );

  // ==========================================================
  // CSV détaillé
  // ==========================================================

  const detailsCsvName =
    `benchmark-v2-${TARGET_TPS}TPS-details.csv`;

  const detailsCsvPath =
    path.join(process.cwd(), detailsCsvName);

  const detailsHeader = [
    "index",
    "sender",
    "receiver",
    "submitted",
    "confirmed",
    "failed",
    "tx_hash",
    "block_number",
    "gas_used",
    "submitted_at",
    "confirmed_at",
    "latency_ms",
    "error",
  ];

  const detailRows = transactions.map((t) => [
    t.index,
    t.sender,
    t.receiver,
    t.submitted,
    t.confirmed,
    t.failed,
    t.txHash || "",
    t.blockNumber ?? "",
    t.gasUsed ?? "",
    t.submittedAt ?? "",
    t.confirmedAt ?? "",
    t.latencyMs ?? "",
    t.error
      ? `"${String(t.error).replace(/"/g, '""')}"`
      : "",
  ]);

  fs.writeFileSync(
    detailsCsvPath,
    detailsHeader.join(",") +
      "\n" +
      detailRows
        .map((row) => row.join(","))
        .join("\n") +
      "\n",
    "utf8"
  );

  console.log(
    `Global CSV  : ${globalCsvName}`
  );

  console.log(
    `Details CSV : ${detailsCsvName}`
  );

  console.log("");
  console.log("Benchmark completed successfully.");
  console.log("");
}

// ============================================================
// Gestion des erreurs globales
// ============================================================

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("");
    console.error("Benchmark failed:");
    console.error(error);
    console.error("");
    process.exit(1);
  });