const hre = require("hardhat");
const fs = require("fs");
require("dotenv").config();

const {
    TARGET_TPS = "10",
    DURATION_SEC = "30",
    MAX_SPONSORS = "20",
    MAX_BROADCAST_IN_FLIGHT = "100",
    TX_TIMEOUT_SEC = "120",
    POLL_INTERVAL_MS = "1000",
    NONCE_RETRIES = "3",
    GAS_LIMIT = "250000",
    TEST_AMOUNT = "1000"
} = process.env;

const targetTPS = Number(TARGET_TPS);
const durationSec = Number(DURATION_SEC);
const maxSponsors = Number(MAX_SPONSORS);
const maxBroadcastInFlight = Number(MAX_BROADCAST_IN_FLIGHT);
const txTimeoutSec = Number(TX_TIMEOUT_SEC);
const pollIntervalMs = Number(POLL_INTERVAL_MS);
const nonceRetries = Number(NONCE_RETRIES);
const gasLimit = BigInt(GAS_LIMIT);
const testAmount = BigInt(TEST_AMOUNT);

const totalTransactions = Math.round(targetTPS * durationSec);

const globalCsv = `benchmark-${targetTPS}TPS.csv`;
const detailsCsv = `benchmark-${targetTPS}TPS-details.csv`;

let rpcErrors = 0;
let nonceErrors = 0;
let timeoutErrors = 0;

let broadcastInFlight = 0;
let maxBroadcastObserved = 0;

const records = [];


// ============================================================
// OUTILS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function percentile(values, p) {

    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);

    const index = (p / 100) * (sorted.length - 1);

    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
        return sorted[lower];
    }

    return sorted[lower] +
        (sorted[upper] - sorted[lower]) * (index - lower);
}


function errorMessage(error) {

    if (!error) {
        return "Erreur inconnue";
    }

    if (error.shortMessage) {
        return error.shortMessage;
    }

    if (error.reason) {
        return error.reason;
    }

    if (error.message) {
        return error.message;
    }

    return String(error);
}


function csvEscape(value) {

    if (value === null || value === undefined) {
        return "";
    }

    const text = String(value);

    if (
        text.includes(",") ||
        text.includes('"') ||
        text.includes("\n")
    ) {
        return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
}


// ============================================================
// LOCK PAR SPONSOR
// ============================================================

const sponsorLocks = new Map();


function withSponsorLock(address, fn) {

    const previous =
        sponsorLocks.get(address) || Promise.resolve();

    const current =
        previous.then(fn, fn);

    sponsorLocks.set(
        address,
        current.catch(() => {})
    );

    return current;
}


// ============================================================
// LIMITEUR DE BROADCAST
// ============================================================

async function acquireBroadcastSlot() {

    while (broadcastInFlight >= maxBroadcastInFlight) {
        await sleep(10);
    }

    broadcastInFlight++;

    if (broadcastInFlight > maxBroadcastObserved) {
        maxBroadcastObserved = broadcastInFlight;
    }
}


function releaseBroadcastSlot() {

    broadcastInFlight--;

    if (broadcastInFlight < 0) {
        broadcastInFlight = 0;
    }
}


// ============================================================
// PROGRAMME PRINCIPAL
// ============================================================

async function main() {

    console.log("");
    console.log("============================================================");
    console.log("             2MUB V5 - BENCHMARK");
    console.log("============================================================");
    console.log("");

    console.log(
        `Target TPS                  : ${targetTPS}`
    );

    console.log(
        `Durée                       : ${durationSec} s`
    );

    console.log(
        `Transactions prévues       : ${totalTransactions}`
    );

    console.log(
        `Sponsors maximum            : ${maxSponsors}`
    );

    console.log(
        `Max broadcast simultanés   : ${maxBroadcastInFlight}`
    );

    console.log(
        `Timeout transaction         : ${txTimeoutSec} s`
    );

    console.log(
        `Retry nonce                 : ${nonceRetries}`
    );

    console.log(
        `Gas limit                   : ${gasLimit}`
    );

    console.log(
        `CSV global                  : ${globalCsv}`
    );

    console.log(
        `CSV détaillé                : ${detailsCsv}`
    );

    console.log("");


    // ========================================================
    // COMPTES
    // ========================================================

    const signers =
        await hre.ethers.getSigners();

    console.log(
        `Comptes disponibles         : ${signers.length}`
    );


    const sponsors =
        signers.slice(
            1,
            Math.min(
                signers.length,
                maxSponsors + 1
            )
        );


    if (sponsors.length === 0) {

        throw new Error(
            "Aucun compte sponsor disponible."
        );
    }


    console.log(
        `Sponsors utilisés           : ${sponsors.length}`
    );

    console.log("");


    // ========================================================
    // DEPLOIEMENT
    // ========================================================

    console.log("Déploiement du contrat...");

    const Factory =
        await hre.ethers.getContractFactory(
            "MobileMoneyCompensation"
        );

    const contract =
        await Factory.deploy();

    await contract.waitForDeployment();

    const contractAddress =
        await contract.getAddress();

    console.log(
        `Contrat déployé             : ${contractAddress}`
    );

    console.log("");


    // ========================================================
    // ENREGISTREMENT DES SPONSORS
    // ========================================================

    console.log("Enregistrement des sponsors...");

    for (let i = 0; i < sponsors.length; i++) {

        const sponsor =
            sponsors[i];

        const tx =
            await contract.registerSponsor(
                await sponsor.getAddress(),
                `Sponsor-${i + 1}`
            );

        await tx.wait();
    }

    console.log(
        `${sponsors.length} sponsors enregistrés.`
    );

    console.log("");


    // ========================================================
    // GAS PRICE
    // ========================================================

    const feeData =
        await hre.ethers.provider.getFeeData();

    let gasPrice =
        feeData.gasPrice;

    if (!gasPrice) {
        gasPrice = 1_000_000_000n;
    }

    console.log(
        `Gas price                  : ${gasPrice.toString()}`
    );

    console.log("");


    // ========================================================
    // SYNCHRONISATION DES NONCES
    // ========================================================

    console.log("Synchronisation des nonces...");

    const nonceState = new Map();

    for (const sponsor of sponsors) {

        const address =
            await sponsor.getAddress();

        const nonce =
            await hre.ethers.provider.getTransactionCount(
                address,
                "pending"
            );

        nonceState.set(
            address,
            nonce
        );

        console.log(
            `${address} -> nonce ${nonce}`
        );
    }

    console.log("");


    // ========================================================
    // CREATION DES RECORDS
    // ========================================================

    for (let i = 0; i < totalTransactions; i++) {

        const sponsor =
            sponsors[i % sponsors.length];

        const sponsorAddress =
            await sponsor.getAddress();

        records.push({

            index: i,

            sponsor:
                sponsorAddress,

            nonce:
                null,

            txHash:
                null,

            scheduledAt:
                null,

            submittedAt:
                null,

            confirmedAt:
                null,

            latencyMs:
                null,

            blockNumber:
                null,

            gasUsed:
                null,

            status:
                "PENDING",

            error:
                ""
        });
    }


    // ========================================================
    // FONCTION DE SOUMISSION
    // ========================================================

    async function submitRecord(record) {

        const sponsor =
            sponsors[
                record.index % sponsors.length
            ];

        const sponsorAddress =
            await sponsor.getAddress();


        return withSponsorLock(
            sponsorAddress,
            async () => {

                let lastError = null;


                for (
                    let attempt = 0;
                    attempt <= nonceRetries;
                    attempt++
                ) {

                    try {

                        await acquireBroadcastSlot();


                        // ------------------------------------
                        // NONCE
                        // ------------------------------------

                        let nonce =
                            nonceState.get(
                                sponsorAddress
                            );


                        if (
                            nonce === undefined ||
                            nonce === null
                        ) {

                            nonce =
                                await hre.ethers.provider.getTransactionCount(
                                    sponsorAddress,
                                    "pending"
                                );

                            nonceState.set(
                                sponsorAddress,
                                nonce
                            );
                        }


                        record.nonce =
                            nonce;


                        // ------------------------------------
                        // DONNEES DE TRANSACTION
                        // ------------------------------------

                        const reqTxHash =
                            hre.ethers.keccak256(
                                hre.ethers.toUtf8Bytes(
                                    `2MUB-REQ-${targetTPS}-${record.index}-${Date.now()}`
                                )
                            );


                        const transfTxHash =
                            hre.ethers.keccak256(
                                hre.ethers.toUtf8Bytes(
                                    `2MUB-TRANSF-${targetTPS}-${record.index}-${Date.now()}`
                                )
                            );


                        const senderWallet =
                            sponsorAddress;


                        const receiverWallet =
                            sponsors[
                                (record.index + 1) %
                                sponsors.length
                            ].address;


                        const data =
                            contract.interface.encodeFunctionData(
                                "processTransaction",
                                [
                                    reqTxHash,
                                    transfTxHash,
                                    senderWallet,
                                    receiverWallet,
                                    testAmount,
                                    true
                                ]
                            );


                        // ------------------------------------
                        // ENVOI
                        // ------------------------------------

                        const tx =
                            await sponsor.sendTransaction({

                                to:
                                    contractAddress,

                                data:
                                    data,

                                nonce:
                                    nonce,

                                gasLimit:
                                    gasLimit,

                                gasPrice:
                                    gasPrice
                            });


                        // Le nonce est avancé seulement
                        // après obtention du hash.
                        nonceState.set(
                            sponsorAddress,
                            nonce + 1
                        );


                        record.txHash =
                            tx.hash;

                        record.submittedAt =
                            Date.now();

                        record.status =
                            "SUBMITTED";


                        releaseBroadcastSlot();


                        return true;


                    } catch (error) {

                        releaseBroadcastSlot();

                        lastError =
                            errorMessage(error);


                        // ------------------------------------
                        // DETECTION ERREUR NONCE
                        // ------------------------------------

                        const msg =
                            lastError.toLowerCase();


                        const isNonceError =
                            msg.includes("nonce") ||
                            msg.includes("replacement") ||
                            msg.includes("already known");


                        if (isNonceError) {

                            nonceErrors++;


                            // Resynchronisation du nonce
                            const freshNonce =
                                await hre.ethers.provider.getTransactionCount(
                                    sponsorAddress,
                                    "pending"
                                );


                            nonceState.set(
                                sponsorAddress,
                                freshNonce
                            );


                            if (
                                attempt <
                                nonceRetries
                            ) {

                                await sleep(
                                    100 * (attempt + 1)
                                );

                                continue;
                            }
                        }


                        // ------------------------------------
                        // ERREUR RPC
                        // ------------------------------------

                        rpcErrors++;

                        record.error =
                            lastError;

                        record.status =
                            "RPC_ERROR";


                        // Affiche les 10 premières erreurs
                        // RPC complètes.
                        if (rpcErrors <= 10) {

                            console.log("");

                            console.log(
                                `[RPC] Transaction ${record.index} - erreur`
                            );

                            console.log(
                                `       Sponsor : ${sponsorAddress}`
                            );

                            console.log(
                                `       Nonce   : ${record.nonce}`
                            );

                            console.log(
                                `       Message : ${lastError}`
                            );

                            console.log("");
                        }


                        return false;
                    }
                }


                record.error =
                    lastError || "Erreur inconnue";

                record.status =
                    "FAILED";

                return false;
            }
        );
    }


    // ========================================================
    // PHASE 1 : GENERATION DE CHARGE
    // ========================================================

    console.log(
        "============================================================"
    );

    console.log(
        "             PHASE 1 : GÉNÉRATION DE CHARGE"
    );

    console.log(
        "============================================================"
    );

    console.log("");


    const generationStart =
        Date.now();

    const broadcastPromises = [];


    for (
        let i = 0;
        i < totalTransactions;
        i++
    ) {

        const targetTime =
            generationStart +
            Math.round(
                (i * 1000) / targetTPS
            );


        const now =
            Date.now();

        const wait =
            targetTime - now;


        if (wait > 0) {
            await sleep(wait);
        }


        records[i].scheduledAt =
            Date.now();


        const promise =
            submitRecord(
                records[i]
            );


        broadcastPromises.push(
            promise
        );


        if (
            (i + 1) % 50 === 0 ||
            i + 1 === totalTransactions
        ) {

            console.log(
                `Charge générée : ${i + 1}/${totalTransactions}`
            );
        }
    }


    const generationEnd =
        Date.now();


    const generationTimeSec =
        (generationEnd - generationStart) /
        1000;


    const offeredTPS =
        totalTransactions /
        generationTimeSec;


    console.log("");

    console.log(
        "Génération terminée."
    );

    console.log(
        `Temps génération           : ${generationTimeSec.toFixed(3)} s`
    );

    console.log(
        `TPS offert                  : ${offeredTPS.toFixed(2)}`
    );

    console.log("");


    // ========================================================
    // ATTENTE DES BROADCASTS
    // ========================================================

    console.log(
        "Attente de la fin des broadcasts RPC..."
    );

    console.log("");


    await Promise.allSettled(
        broadcastPromises
    );


    const submittedRecords =
        records.filter(
            r => r.txHash
        );


    console.log(
        `Transactions soumises      : ${submittedRecords.length}/${totalTransactions}`
    );

    console.log(
        `Erreurs nonce               : ${nonceErrors}`
    );

    console.log(
        `Erreurs RPC                 : ${rpcErrors}`
    );

    console.log("");


    // ========================================================
    // PHASE 2 : DRAINAGE
    // ========================================================

    console.log(
        "============================================================"
    );

    console.log(
        "                PHASE 2 : DRAINAGE"
    );

    console.log(
        "============================================================"
    );

    console.log("");


    console.log(
        `Transactions à surveiller : ${submittedRecords.length}`
    );


    const drainStart =
        Date.now();


    const pending =
        new Map();


    for (const record of submittedRecords) {

        pending.set(
            record.index,
            record
        );
    }


    while (pending.size > 0) {

        for (const [index, record] of pending) {

            try {

                const receipt =
                    await hre.ethers.provider.getTransactionReceipt(
                        record.txHash
                    );


                if (receipt) {

                    record.confirmedAt =
                        Date.now();

                    record.blockNumber =
                        receipt.blockNumber;

                    record.gasUsed =
                        receipt.gasUsed.toString();

                    record.latencyMs =
                        record.confirmedAt -
                        record.scheduledAt;

                    record.status =
                        "CONFIRMED";


                    pending.delete(index);
                }


            } catch (error) {

                record.error =
                    errorMessage(error);
            }
        }


        const confirmed =
            submittedRecords.length -
            pending.size;


        console.log(
            `Confirmations : ${confirmed}/${submittedRecords.length} | Restantes : ${pending.size}`
        );


        if (pending.size === 0) {
            break;
        }


        const elapsed =
            (Date.now() - drainStart) /
            1000;


        if (elapsed >= txTimeoutSec) {

            for (const record of pending.values()) {

                record.status =
                    "TIMEOUT";

                timeoutErrors++;
            }

            break;
        }


        await sleep(
            pollIntervalMs
        );
    }


    const endTime =
        Date.now();


    const totalTimeSec =
        (endTime - generationStart) /
        1000;


    const drainTimeSec =
        (endTime - drainStart) /
        1000;


    // ========================================================
    // CALCUL DES METRIQUES
    // ========================================================

    const confirmedRecords =
        records.filter(
            r =>
                r.status === "CONFIRMED"
        );


    const successful =
        confirmedRecords.length;


    const submitted =
        submittedRecords.length;


    const successRate =
        totalTransactions > 0
            ? (successful / totalTransactions) * 100
            : 0;


    const confirmedTPS =
        totalTimeSec > 0
            ? successful / totalTimeSec
            : 0;


    const confirmationTPS =
        drainTimeSec > 0
            ? successful / drainTimeSec
            : 0;


    const latencies =
        confirmedRecords
            .map(r => r.latencyMs)
            .filter(v =>
                typeof v === "number"
            );


    const gasValues =
        confirmedRecords
            .map(r => Number(r.gasUsed))
            .filter(v =>
                Number.isFinite(v)
            );


    const latencyMin =
        latencies.length
            ? Math.min(...latencies)
            : 0;


    const latencyMax =
        latencies.length
            ? Math.max(...latencies)
            : 0;


    const latencyAvg =
        latencies.length
            ? latencies.reduce(
                (a, b) => a + b,
                0
            ) / latencies.length
            : 0;


    const p50 =
        percentile(
            latencies,
            50
        );


    const p95 =
        percentile(
            latencies,
            95
        );


    const p99 =
        percentile(
            latencies,
            99
        );


    const gasMin =
        gasValues.length
            ? Math.min(...gasValues)
            : 0;


    const gasMax =
        gasValues.length
            ? Math.max(...gasValues)
            : 0;


    const gasAvg =
        gasValues.length
            ? gasValues.reduce(
                (a, b) => a + b,
                0
            ) / gasValues.length
            : 0;


    // ========================================================
    // BLOCS
    // ========================================================

    const blockNumbers =
        confirmedRecords
            .map(r => r.blockNumber)
            .filter(v =>
                Number.isInteger(v)
            );


    let blocksUsed = 0;
    let txPerBlock = 0;


    if (blockNumbers.length > 0) {

        const minBlock =
            Math.min(...blockNumbers);

        const maxBlock =
            Math.max(...blockNumbers);

        blocksUsed =
            maxBlock - minBlock + 1;

        txPerBlock =
            successful / blocksUsed;
    }


    // ========================================================
    // RESULTATS
    // ========================================================

    console.log("");

    console.log(
        "============================================================"
    );

    console.log(
        "                    RESULTATS"
    );

    console.log(
        "============================================================"
    );

    console.log("");


    console.log(
        `Palier cible              : ${targetTPS} TPS`
    );

    console.log(
        `Durée demandée            : ${durationSec} s`
    );

    console.log(
        `Transactions demandées    : ${totalTransactions}`
    );

    console.log(
        `Transactions soumises     : ${submitted}`
    );

    console.log(
        `Transactions réussies     : ${successful}`
    );

    console.log(
        `Transactions échouées     : ${totalTransactions - successful}`
    );

    console.log(
        `Taux de réussite          : ${successRate.toFixed(2)} %`
    );

    console.log("");


    console.log(
        "--------------- DEBIT ----------------"
    );

    console.log(
        `TPS offert                : ${offeredTPS.toFixed(2)}`
    );

    console.log(
        `TPS confirmé             : ${confirmedTPS.toFixed(2)}`
    );

    console.log(
        `TPS confirmation/drain   : ${confirmationTPS.toFixed(2)}`
    );

    console.log("");


    console.log(
        "--------------- TEMPS ----------------"
    );

    console.log(
        `Temps génération          : ${generationTimeSec.toFixed(3)} s`
    );

    console.log(
        `Temps drainage            : ${drainTimeSec.toFixed(3)} s`
    );

    console.log(
        `Temps total               : ${totalTimeSec.toFixed(3)} s`
    );

    console.log("");


    console.log(
        "--------------- LATENCE --------------"
    );

    console.log(
        `Min                       : ${latencyMin.toFixed(2)} ms`
    );

    console.log(
        `P50                       : ${p50.toFixed(2)} ms`
    );

    console.log(
        `Moyenne                   : ${latencyAvg.toFixed(2)} ms`
    );

    console.log(
        `P95                       : ${p95.toFixed(2)} ms`
    );

    console.log(
        `P99                       : ${p99.toFixed(2)} ms`
    );

    console.log(
        `Max                       : ${latencyMax.toFixed(2)} ms`
    );

    console.log("");


    console.log(
        "--------------- GAS ------------------"
    );

    console.log(
        `Gas min                   : ${gasMin}`
    );

    console.log(
        `Gas moyen                 : ${gasAvg.toFixed(2)}`
    );

    console.log(
        `Gas max                   : ${gasMax}`
    );

    console.log("");


    console.log(
        "--------------- BLOCS ----------------"
    );

    console.log(
        `Blocs utilisés            : ${blocksUsed}`
    );

    console.log(
        `Transactions/bloc         : ${txPerBlock.toFixed(2)}`
    );

    console.log("");


    console.log(
        "--------------- ERREURS --------------"
    );

    console.log(
        `Erreurs RPC               : ${rpcErrors}`
    );

    console.log(
        `Erreurs nonce             : ${nonceErrors}`
    );

    console.log(
        `Timeouts                  : ${timeoutErrors}`
    );

    console.log(
        `Max broadcasts simultanés : ${maxBroadcastObserved}`
    );

    console.log("");


    // ========================================================
    // CSV GLOBAL
    // ========================================================

    const globalHeader = [
        "target_tps",
        "duration_sec",
        "transactions_requested",
        "transactions_submitted",
        "transactions_confirmed",
        "success_rate_percent",
        "offered_tps",
        "confirmed_tps",
        "confirmation_tps",
        "generation_time_sec",
        "drain_time_sec",
        "total_time_sec",
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
        "tx_per_block",
        "rpc_errors",
        "nonce_errors",
        "timeouts",
        "max_broadcast_in_flight"
    ];


    const globalValues = [

        targetTPS,
        durationSec,
        totalTransactions,
        submitted,
        successful,

        successRate.toFixed(2),

        offeredTPS.toFixed(2),
        confirmedTPS.toFixed(2),
        confirmationTPS.toFixed(2),

        generationTimeSec.toFixed(3),
        drainTimeSec.toFixed(3),
        totalTimeSec.toFixed(3),

        latencyMin.toFixed(2),
        p50.toFixed(2),
        latencyAvg.toFixed(2),
        p95.toFixed(2),
        p99.toFixed(2),
        latencyMax.toFixed(2),

        gasMin,
        gasAvg.toFixed(2),
        gasMax,

        blocksUsed,
        txPerBlock.toFixed(2),

        rpcErrors,
        nonceErrors,
        timeoutErrors,

        maxBroadcastObserved
    ];


    fs.writeFileSync(
        globalCsv,
        globalHeader.join(",") +
        "\n" +
        globalValues.join(",") +
        "\n"
    );


    // ========================================================
    // CSV DETAILLE
    // ========================================================

    const detailHeader = [

        "index",
        "sponsor",
        "nonce",
        "tx_hash",
        "scheduled_at",
        "submitted_at",
        "confirmed_at",
        "latency_ms",
        "block_number",
        "gas_used",
        "status",
        "error"
    ];


    const detailLines = [
        detailHeader.join(",")
    ];


    for (const record of records) {

        detailLines.push(

            [
                record.index,
                record.sponsor,
                record.nonce,
                record.txHash,
                record.scheduledAt,
                record.submittedAt,
                record.confirmedAt,
                record.latencyMs,
                record.blockNumber,
                record.gasUsed,
                record.status,
                record.error
            ]
                .map(csvEscape)
                .join(",")
        );
    }


    fs.writeFileSync(
        detailsCsv,
        detailLines.join("\n") +
        "\n"
    );


    // ========================================================
    // FIN
    // ========================================================

    console.log(
        "============================================================"
    );

    console.log(
        "                    FIN DU TEST"
    );

    console.log(
        "============================================================"
    );

    console.log("");

    console.log(
        `CSV global       : ${globalCsv}`
    );

    console.log(
        `CSV détaillé     : ${detailsCsv}`
    );

    console.log("");
}


main()
    .then(() => process.exit(0))
    .catch(error => {

        console.error("");
        console.error(
            "ERREUR FATALE :"
        );
        console.error(
            error
        );

        process.exit(1);
    });