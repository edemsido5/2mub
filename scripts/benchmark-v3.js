const { ethers } = require("hardhat");

// ============================================================
// BENCHMARK 2MUB V3
// MobileMoneyCompensation
//
// Objectifs :
//  - Générer une charge réellement offerte pendant DURATION_SEC
//  - Séparer génération et confirmation
//  - Mesurer Offered TPS / Submission TPS / Confirmed TPS
//  - Mesurer P50 / P95 / P99 / moyenne / min / max
//  - Mesurer gasUsed
//  - Mesurer blocs utilisés
//  - Mesurer transactions par bloc
//  - Mesurer le temps de drainage
//  - Détecter une saturation
// ============================================================


// ============================================================
// CONFIGURATION
// ============================================================

const TARGET_TPS = parseInt(
  process.env.TARGET_TPS || "10",
  10
);

const DURATION_SEC = parseInt(
  process.env.DURATION_SEC || "10",
  10
);

// Nombre de comptes utilisés comme sponsors
const MAX_SPONSORS = parseInt(
  process.env.MAX_SPONSORS || "20",
  10
);

// Nombre maximal de requêtes RPC simultanées.
// Cette limite protège le RPC sans ralentir volontairement
// la durée de génération de charge.
// Elle n'est PAS utilisée pour arrêter la génération pendant
// les 10 secondes.
const MAX_RPC_IN_FLIGHT = parseInt(
  process.env.MAX_RPC_IN_FLIGHT || "200",
  10
);

const GAS_LIMIT = 250000;

// Marge utilisée pour considérer qu'une charge provoque
// une saturation.
const SATURATION_LATENCY_P95_MS = 30000;
const SATURATION_LATENCY_P99_MS = 60000;


// ============================================================
// OUTILS
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// ------------------------------------------------------------
// Percentile
// ------------------------------------------------------------

function percentile(values, p) {

  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort(
    (a, b) => a - b
  );

  const index =
    (p / 100) *
    (sorted.length - 1);

  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sorted[lower];
  }

  return (
    sorted[lower] +
    (sorted[upper] - sorted[lower]) *
      (index - lower)
  );
}


// ------------------------------------------------------------
// Moyenne
// ------------------------------------------------------------

function average(values) {

  if (!values.length) {
    return 0;
  }

  return (
    values.reduce(
      (sum, value) => sum + value,
      0
    ) / values.length
  );
}


// ------------------------------------------------------------
// Format
// ------------------------------------------------------------

function formatNumber(value, decimals = 2) {
  return Number(value).toFixed(decimals);
}


// ============================================================
// MAIN
// ============================================================

async function main() {

  console.log("");
  console.log("============================================================");
  console.log("              BENCHMARK 2MUB - V3");
  console.log("============================================================");
  console.log("");

  console.log(
    `Target TPS              : ${TARGET_TPS}`
  );

  console.log(
    `Durée de génération    : ${DURATION_SEC} secondes`
  );

  console.log(
    `Transactions prévues   : ${TARGET_TPS * DURATION_SEC}`
  );

  console.log(
    `Sponsors               : ${MAX_SPONSORS}`
  );

  console.log(
    `RPC max in-flight      : ${MAX_RPC_IN_FLIGHT}`
  );

  console.log(
    `Gas limit transaction  : ${GAS_LIMIT}`
  );

  console.log("");


  // ==========================================================
  // 1. COMPTES
  // ==========================================================

  const signers =
    await ethers.getSigners();

  if (signers.length < 2) {

    throw new Error(
      "Il faut au moins 2 comptes Hardhat."
    );

  }

  const regulator =
    signers[0];

  const sponsors =
    signers.slice(
      1,
      Math.min(
        signers.length,
        MAX_SPONSORS + 1
      )
    );

  if (!sponsors.length) {

    throw new Error(
      "Aucun compte sponsor disponible."
    );

  }

  console.log(
    `Comptes Hardhat        : ${signers.length}`
  );

  console.log(
    `Sponsors utilisés      : ${sponsors.length}`
  );


  // ==========================================================
  // 2. DEPLOIEMENT
  // ==========================================================

  console.log("");
  console.log(
    "Déploiement du contrat..."
  );

  const Factory =
    await ethers.getContractFactory(
      "MobileMoneyCompensation"
    );

  const contract =
    await Factory.deploy();

  await contract.waitForDeployment();

  const contractAddress =
    await contract.getAddress();

  console.log(
    `Contrat                : ${contractAddress}`
  );


  // ==========================================================
  // 3. ENREGISTREMENT DES SPONSORS
  // ==========================================================

  console.log("");
  console.log(
    "Enregistrement des sponsors..."
  );

  for (
    let i = 0;
    i < sponsors.length;
    i++
  ) {

    const sponsor =
      sponsors[i];

    const tx =
      await contract
        .connect(regulator)
        .registerSponsor(
          sponsor.address,
          `SponsorTest-${i + 1}`
        );

    await tx.wait();

  }

  console.log(
    `${sponsors.length} sponsors enregistrés.`
  );


  // ==========================================================
  // 4. NONCES
  // ==========================================================

  const nonces = {};

  for (
    const sponsor of sponsors
  ) {

    nonces[sponsor.address] =
      await ethers.provider.getTransactionCount(
        sponsor.address,
        "pending"
      );

  }


  // ==========================================================
  // 5. VARIABLES DU BENCHMARK
  // ==========================================================

  const totalExpectedTx =
    TARGET_TPS * DURATION_SEC;

  let generatedCount = 0;

  let submittedCount = 0;

  let successCount = 0;

  let failedCount = 0;

  let rpcErrorCount = 0;

  let maxRpcInFlightObserved = 0;

  let rpcInFlight = 0;


  // ----------------------------------------------------------
  // Résultats
  // ----------------------------------------------------------

  const transactionResults = [];

  const latencyValues = [];

  const gasValues = [];

  const blockNumbers = [];


  // ==========================================================
  // 6. PROMESSES DE CONFIRMATION
  // ==========================================================

  const confirmationPromises = [];


  // ==========================================================
  // 7. ENVOI D'UNE TRANSACTION
  // ==========================================================

  async function submitTransaction(index) {

    const sponsor =
      sponsors[
        index % sponsors.length
      ];


    // --------------------------------------------------------
    // Nonce
    // --------------------------------------------------------

    const nonce =
      nonces[sponsor.address]++;


    // --------------------------------------------------------
    // Hash unique
    // --------------------------------------------------------

    const reqHash =
      ethers.keccak256(
        ethers.toUtf8Bytes(
          `2MUB-REQ-${TARGET_TPS}-${DURATION_SEC}-${index}-${Date.now()}-${Math.random()}`
        )
      );


    const transfHash =
      ethers.keccak256(
        ethers.toUtf8Bytes(
          `2MUB-TRANSF-${TARGET_TPS}-${DURATION_SEC}-${index}-${Date.now()}-${Math.random()}`
        )
      );


    // --------------------------------------------------------
    // Temps de départ
    // --------------------------------------------------------

    const t0 =
      Date.now();


    rpcInFlight++;

    if (
      rpcInFlight >
      maxRpcInFlightObserved
    ) {

      maxRpcInFlightObserved =
        rpcInFlight;

    }


    try {

      // ------------------------------------------------------
      // Envoi de la transaction
      // ------------------------------------------------------

      const tx =
        await contract
          .connect(sponsor)
          .processTransaction(
            reqHash,
            transfHash,
            sponsor.address,
            regulator.address,
            1000,
            true,
            {
              nonce,
              gasLimit: GAS_LIMIT
            }
          );


      submittedCount++;


      const txHash =
        tx.hash;


      // ------------------------------------------------------
      // Confirmation
      // ------------------------------------------------------

      const receipt =
        await tx.wait();


      const t1 =
        Date.now();


      const latency =
        t1 - t0;


      const result = {

        index,

        ok:
          receipt &&
          receipt.status === 1,

        latency,

        gasUsed:
          receipt &&
          receipt.gasUsed
            ? Number(receipt.gasUsed)
            : 0,

        blockNumber:
          receipt &&
          receipt.blockNumber !== null
            ? Number(
                receipt.blockNumber
              )
            : null,

        txHash

      };


      transactionResults.push(
        result
      );


      // ------------------------------------------------------
      // Succès
      // ------------------------------------------------------

      if (result.ok) {

        successCount++;

        latencyValues.push(
          latency
        );


        if (result.gasUsed > 0) {

          gasValues.push(
            result.gasUsed
          );

        }


        if (
          result.blockNumber !== null
        ) {

          blockNumbers.push(
            result.blockNumber
          );

        }

      } else {

        failedCount++;

      }


    } catch (error) {

      failedCount++;

      rpcErrorCount++;


      if (rpcErrorCount <= 10) {

        console.log("");

        console.log(
          `[RPC] Transaction ${index + 1} échouée`
        );

        console.log(
          error.shortMessage ||
          error.message ||
          String(error)
        );

      }

    } finally {

      rpcInFlight--;

    }

  }


  // ==========================================================
  // 8. GENERATION DE CHARGE
  //
  // IMPORTANT :
  //
  // On ne fait PAS :
  //
  //     await submitTransaction()
  //
  // dans la boucle.
  //
  // Les transactions sont lancées selon l'horloge de charge.
  // ==========================================================

  console.log("");
  console.log(
    "============================================================"
  );
  console.log(
    "          PHASE 1 : GENERATION DE CHARGE"
  );
  console.log(
    "============================================================"
  );

  console.log("");

  console.log(
    `Objectif : ${TARGET_TPS} TPS pendant ${DURATION_SEC} secondes`
  );

  console.log("");


  const generationStart =
    Date.now();


  const generationDurationMs =
    DURATION_SEC * 1000;


  const intervalMs =
    1000 / TARGET_TPS;


  let nextTargetTime =
    generationStart;


  // ----------------------------------------------------------
  // Génération pendant EXACTEMENT DURATION_SEC
  // ----------------------------------------------------------

  while (
    Date.now() -
      generationStart <
    generationDurationMs
  ) {

    // --------------------------------------------------------
    // Attendre jusqu'au prochain instant d'envoi
    // --------------------------------------------------------

    const now =
      Date.now();

    const delay =
      nextTargetTime - now;

    if (delay > 0) {

      await sleep(delay);

    }


    // --------------------------------------------------------
    // Si le RPC est momentanément saturé
    //
    // On attend légèrement, mais on ne fait pas dépendre
    // la phase de génération des confirmations.
    // --------------------------------------------------------

    if (
      rpcInFlight >=
      MAX_RPC_IN_FLIGHT
    ) {

      await sleep(2);

      continue;

    }


    // --------------------------------------------------------
    // Génération
    // --------------------------------------------------------

    const index =
      generatedCount;

    generatedCount++;


    const promise =
      submitTransaction(index);


    confirmationPromises.push(
      promise
    );


    // --------------------------------------------------------
    // Prochaine échéance
    // --------------------------------------------------------

    nextTargetTime +=
      intervalMs;


    // --------------------------------------------------------
    // Protection contre un retard important
    // --------------------------------------------------------

    const current =
      Date.now();

    if (
      nextTargetTime <
      current
    ) {

      nextTargetTime =
        current;

    }

  }


  const generationEnd =
    Date.now();


  const generationElapsedSec =
    (
      generationEnd -
      generationStart
    ) / 1000;


  console.log("");

  console.log(
    "Fin de la génération de charge."
  );

  console.log(
    `Transactions générées : ${generatedCount}`
  );

  console.log(
    `Durée réelle génération : ${formatNumber(generationElapsedSec, 3)} s`
  );


  // ==========================================================
  // 9. OFFLOADED / OFFERED TPS
  // ==========================================================

  const offeredTPS =
    generatedCount /
    Math.max(
      generationElapsedSec,
      0.001
    );


  console.log("");

  console.log(
    `Charge effectivement offerte : ${formatNumber(offeredTPS)} TPS`
  );


  // ==========================================================
  // 10. PHASE DE DRAINAGE
  // ==========================================================

  console.log("");
  console.log(
    "============================================================"
  );
  console.log(
    "             PHASE 2 : DRAINAGE"
  );
  console.log(
    "============================================================"
  );

  console.log("");

  console.log(
    "La génération est arrêtée."
  );

  console.log(
    "Attente des confirmations restantes..."
  );

  console.log("");


  const drainStart =
    Date.now();


  await Promise.all(
    confirmationPromises
  );


  const drainEnd =
    Date.now();


  const drainElapsedSec =
    (
      drainEnd -
      drainStart
    ) / 1000;


  console.log(
    `Drainage terminé en ${formatNumber(drainElapsedSec, 3)} s`
  );


  // ==========================================================
  // 11. TEMPS TOTAL
  // ==========================================================

  const totalElapsedSec =
    (
      drainEnd -
      generationStart
    ) / 1000;


  // ==========================================================
  // 12. TPS
  // ==========================================================

  const submissionTPS =
    submittedCount /
    Math.max(
      generationElapsedSec,
      0.001
    );


  const confirmedTPS =
    successCount /
    Math.max(
      totalElapsedSec,
      0.001
    );


  const drainTPS =
    successCount /
    Math.max(
      drainElapsedSec,
      0.001
    );


  // ==========================================================
  // 13. LATENCES
  // ==========================================================

  const minLatency =
    latencyValues.length
      ? Math.min(
          ...latencyValues
        )
      : 0;


  const maxLatency =
    latencyValues.length
      ? Math.max(
          ...latencyValues
        )
      : 0;


  const avgLatency =
    average(
      latencyValues
    );


  const p50 =
    percentile(
      latencyValues,
      50
    );


  const p95 =
    percentile(
      latencyValues,
      95
    );


  const p99 =
    percentile(
      latencyValues,
      99
    );


  // ==========================================================
  // 14. GAS
  // ==========================================================

  const minGas =
    gasValues.length
      ? Math.min(
          ...gasValues
        )
      : 0;


  const maxGas =
    gasValues.length
      ? Math.max(
          ...gasValues
        )
      : 0;


  const avgGas =
    average(
      gasValues
    );


  // ==========================================================
  // 15. BLOCS
  // ==========================================================

  const uniqueBlocks =
    [
      ...new Set(
        blockNumbers
      )
    ].sort(
      (a, b) => a - b
    );


  const transactionsPerBlock =
    uniqueBlocks.length
      ? successCount /
        uniqueBlocks.length
      : 0;


  // ==========================================================
  // 16. TPS THEORIQUE BASE SUR GAS
  // ==========================================================

  const blockGasLimit =
    60000000;


  const theoreticalTxPerBlock =
    avgGas > 0
      ? Math.floor(
          blockGasLimit /
          avgGas
        )
      : 0;


  const theoreticalTPS =
    theoreticalTxPerBlock /
    2;


  // ==========================================================
  // 17. DETECTION DE SATURATION
  // ==========================================================

  let saturationDetected =
    false;


  const saturationReasons = [];


  // ----------------------------------------------------------
  // Condition 1 : la charge offerte n'est pas atteinte
  // ----------------------------------------------------------

  const offeredRatio =
    offeredTPS /
    Math.max(
      TARGET_TPS,
      1
    );


  if (
    offeredRatio < 0.90
  ) {

    saturationDetected = true;

    saturationReasons.push(
      "la charge offerte est inférieure à 90 % de la cible"
    );

  }


  // ----------------------------------------------------------
  // Condition 2 : P95 élevé
  // ----------------------------------------------------------

  if (
    p95 >
    SATURATION_LATENCY_P95_MS
  ) {

    saturationDetected = true;

    saturationReasons.push(
      "P95 de latence supérieur à 30 secondes"
    );

  }


  // ----------------------------------------------------------
  // Condition 3 : P99 élevé
  // ----------------------------------------------------------

  if (
    p99 >
    SATURATION_LATENCY_P99_MS
  ) {

    saturationDetected = true;

    saturationReasons.push(
      "P99 de latence supérieur à 60 secondes"
    );

  }


  // ----------------------------------------------------------
  // Condition 4 : erreurs
  // ----------------------------------------------------------

  if (
    failedCount > 0
  ) {

    saturationDetected = true;

    saturationReasons.push(
      "des transactions ont échoué"
    );

  }


  // ==========================================================
  // 18. RESULTATS FINAUX
  // ==========================================================

  console.log("");
  console.log("");
  console.log(
    "============================================================"
  );
  console.log(
    "                  RESULTATS V3"
  );
  console.log(
    "============================================================"
  );


  console.log("");

  console.log(
    "--------------- CHARGE ------------------"
  );

  console.log(
    `TPS cible                  : ${TARGET_TPS}`
  );

  console.log(
    `Durée cible                : ${DURATION_SEC} s`
  );

  console.log(
    `Transactions prévues       : ${totalExpectedTx}`
  );

  console.log(
    `Transactions générées     : ${generatedCount}`
  );

  console.log(
    `Charge offerte réelle      : ${formatNumber(offeredTPS)} TPS`
  );


  console.log("");

  console.log(
    "--------------- TRANSACTIONS ------------"
  );

  console.log(
    `Soumises                  : ${submittedCount}`
  );

  console.log(
    `Réussies                  : ${successCount}`
  );

  console.log(
    `Échouées                  : ${failedCount}`
  );

  console.log(
    `Erreurs RPC               : ${rpcErrorCount}`
  );


  const successRate =
    submittedCount
      ? (
          successCount /
          submittedCount
        ) * 100
      : 0;


  console.log(
    `Taux de réussite          : ${formatNumber(successRate)} %`
  );


  console.log("");

  console.log(
    "--------------- TPS ---------------------"
  );

  console.log(
    `Offered TPS               : ${formatNumber(offeredTPS)}`
  );

  console.log(
    `Submission TPS            : ${formatNumber(submissionTPS)}`
  );

  console.log(
    `Confirmed TPS total       : ${formatNumber(confirmedTPS)}`
  );

  console.log(
    `TPS pendant drainage      : ${formatNumber(drainTPS)}`
  );


  console.log("");

  console.log(
    "--------------- TEMPS -------------------"
  );

  console.log(
    `Génération                : ${formatNumber(generationElapsedSec, 3)} s`
  );

  console.log(
    `Drainage                  : ${formatNumber(drainElapsedSec, 3)} s`
  );

  console.log(
    `Temps total               : ${formatNumber(totalElapsedSec, 3)} s`
  );


  console.log("");

  console.log(
    "--------------- LATENCE -----------------"
  );

  console.log(
    `Min                       : ${formatNumber(minLatency, 1)} ms`
  );

  console.log(
    `P50                       : ${formatNumber(p50, 1)} ms`
  );

  console.log(
    `Moyenne                   : ${formatNumber(avgLatency, 1)} ms`
  );

  console.log(
    `P95                       : ${formatNumber(p95, 1)} ms`
  );

  console.log(
    `P99                       : ${formatNumber(p99, 1)} ms`
  );

  console.log(
    `Max                       : ${formatNumber(maxLatency, 1)} ms`
  );


  console.log("");

  console.log(
    "--------------- GAS ---------------------"
  );

  console.log(
    `Gas min                   : ${minGas}`
  );

  console.log(
    `Gas moyen                 : ${formatNumber(avgGas, 0)}`
  );

  console.log(
    `Gas max                   : ${maxGas}`
  );


  console.log("");

  console.log(
    "--------------- BLOCS -------------------"
  );

  console.log(
    `Blocs utilisés            : ${uniqueBlocks.length}`
  );

  console.log(
    `Transactions/bloc         : ${formatNumber(transactionsPerBlock)}`
  );

  console.log(
    `Max RPC in-flight         : ${maxRpcInFlightObserved}`
  );


  console.log("");

  console.log(
    "--------------- CAPACITE GAS ------------"
  );

  console.log(
    `Gas limite/bloc           : ${blockGasLimit}`
  );

  console.log(
    `Tx théoriques/bloc        : ${theoreticalTxPerBlock}`
  );

  console.log(
    `TPS théorique basée gas   : ${formatNumber(theoreticalTPS)}`
  );


  console.log("");

  console.log(
    "--------------- SATURATION --------------"
  );


  if (
    saturationDetected
  ) {

    console.log(
      "SATURATION DETECTEE : OUI"
    );

    for (
      const reason of saturationReasons
    ) {

      console.log(
        ` - ${reason}`
      );

    }

  } else {

    console.log(
      "SATURATION DETECTEE : NON"
    );

  }


  console.log("");

  console.log(
    "============================================================"
  );

  console.log(
    "Benchmark V3 terminé."
  );

  console.log(
    "============================================================"
  );

  console.log("");
}


// ============================================================
// EXECUTION
// ============================================================

main()
  .catch(
    (error) => {

      console.error("");

      console.error(
        "ERREUR FATALE DU BENCHMARK"
      );

      console.error(
        error.shortMessage ||
        error.message ||
        error
      );

      process.exitCode = 1;

    }
  );