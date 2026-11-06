import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";

// Trésorerie de test (build `--features test-treasury`) : destinataire des frais de plateforme et arbitre. En recette
// et en production, c'est un vault Squads (multisig 2 sur 3) ; sur le validateur local, une clé qui signe elle-même.
export const TREASURY_KEYPAIR = anchor.web3.Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "test-treasury.json"), "utf8")))
);
export const TREASURY = TREASURY_KEYPAIR.publicKey;

// Trésorerie approvisionnée une fois pour toutes les suites (réserve de loyer, comptes de jetons de l'arbitre).
before(async () => {
  const provider = anchor.AnchorProvider.env();
  if ((await provider.connection.getBalance(TREASURY)) > 0) return;
  const sig = await provider.connection.requestAirdrop(TREASURY, 5 * anchor.web3.LAMPORTS_PER_SOL);
  const latest = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...latest });
});
