import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
} from "@solana/spl-token";
import { expect, AssertionError } from "chai";
import { AnchorWorkspace } from "../target/types/anchor_workspace";
import { TREASURY, TREASURY_KEYPAIR } from "./treasury";

// Garantie (timelock) : ouverte par la plateforme au dépôt des documents ; à son terme, sans vote « rembourser » ni
// litige (suspension), n'importe qui déclenche le versement au vendeur.
describe("garantie : versement automatique au vendeur à l'échéance", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.anchorWorkspace as Program<AnchorWorkspace>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const platformKeypair = (provider.wallet as anchor.Wallet).payer;

  const PLATFORM = new anchor.web3.PublicKey("HrGT7nC7wTEC7YaDetkUyiscQcRtwGRLn6wb1cNrr7hP");
  const USDC = new anchor.web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const RELEASE = 1;
  const REFUND = 2;
  const AMOUNT = 1_000_000;
  const LOCKED = 925_000;
  const SHORT = 2; // secondes : garantie courte pour les tests
  const SEEDS = [9_250, 150, 600].map(v => new anchor.BN(v).toArrayLike(Buffer, "le", 8));

  const expectRejection = (error: unknown, code: string) => {
    if (error instanceof AssertionError) throw error;
    expect(String(error)).to.contain(code);
  };
  const airdrop = async (pubkey: anchor.web3.PublicKey, sol = 2) => {
    const sig = await provider.connection.requestAirdrop(pubkey, sol * anchor.web3.LAMPORTS_PER_SOL);
    const latest = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...latest });
  };
  const lamports = (pubkey: anchor.web3.PublicKey) => provider.connection.getBalance(pubkey);
  const wait = (seconds: number) => new Promise(resolve => setTimeout(resolve, seconds * 1000));
  // Échéance de garantie : on attend l'horloge du validateur (Clock), pas l'horloge murale ; un validateur chargé
  // prend du retard et l'échéance n'y serait pas encore atteinte.
  const chainTime = async () => {
    for (;;) { const time = await provider.connection.getBlockTime(await provider.connection.getSlot()); if (time !== null) return time; await wait(0.2); }
  };
  const waitChainSeconds = async (seconds: number) => {
    const until = (await chainTime()) + seconds;
    for (let i = 0; i < 300 && (await chainTime()) < until; i++) await wait(0.5);
  };
  const lockOf = (distribution: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("guarantee"), distribution.toBuffer()], program.programId)[0];
  const termsOf = (distribution: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("terms"), distribution.toBuffer()], program.programId)[0];

  // Termes du dépôt signés par l'acheteur (durée contractuelle de la garantie, 0 : pas de versement automatique).
  const recordTerms = (distribution: anchor.web3.PublicKey, funder: anchor.web3.Keypair, seconds: number) =>
    program.methods.recordTerms(new anchor.BN(seconds)).accountsPartial({
      terms: termsOf(distribution), distribution, funder: funder.publicKey, platform: PLATFORM, systemProgram: anchor.web3.SystemProgram.programId,
    }).signers([funder]).rpc();
  // Ouverture : signée par la plateforme (wallet du provider) ou, pour les refus, par un tiers. Suspension : par la
  // plateforme ou par l'acheteur.
  const start = (distribution: anchor.web3.PublicKey, seconds: number, signer: anchor.web3.Keypair | null = null) => {
    const call = program.methods.startGuarantee(new anchor.BN(seconds)).accountsPartial({
      lock: lockOf(distribution), distribution, terms: termsOf(distribution), platform: signer ? signer.publicKey : PLATFORM, systemProgram: anchor.web3.SystemProgram.programId,
    });
    return signer ? call.signers([signer]).rpc() : call.rpc();
  };
  const suspend = (distribution: anchor.web3.PublicKey, signer: anchor.web3.Keypair | null = null) => {
    const call = program.methods.suspendGuarantee().accountsPartial({ lock: lockOf(distribution), distribution, authority: signer ? signer.publicKey : PLATFORM });
    return signer ? call.signers([signer]).rpc() : call.rpc();
  };

  async function solDeal(termsSeconds: number | null = SHORT) {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    const stranger = anchor.web3.Keypair.generate();
    await airdrop(buyer.publicKey);
    await airdrop(seller.publicKey, 1);
    await airdrop(sponsor.publicKey, 1);
    await airdrop(stranger.publicKey, 1);
    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const idBytes = paymentId.toArrayLike(Buffer, "le", 8);
    const [distribution] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("distribution"), buyer.publicKey.toBuffer(), idBytes], program.programId);
    const [vault] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("vault"), buyer.publicKey.toBuffer(), idBytes, ...SEEDS], program.programId);
    await program.methods.initializeDistributionExact(paymentId, new anchor.BN(AMOUNT), new anchor.BN(AMOUNT * 600 / 10_000), new anchor.BN(AMOUNT * 150 / 10_000))
      .accountsPartial({
        distribution, vault, payer: PLATFORM, funder: buyer.publicKey,
        recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee6: TREASURY,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([buyer]).rpc();
    if (termsSeconds !== null) await recordTerms(distribution, buyer, termsSeconds);
    const vote = (voter: anchor.web3.Keypair | null, decision: number) => {
      const call = program.methods.voteDistribution(decision).accountsPartial({
        distribution, vault, voter: (voter ?? TREASURY_KEYPAIR).publicKey, funder: buyer.publicKey, recipientLocked: seller.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      });
      return call.signers([voter ?? TREASURY_KEYPAIR]).rpc();
    };
    // Versement déclenché par un tiers quelconque (n'importe qui peut le faire).
    const release = (caller: anchor.web3.Keypair = stranger) => program.methods.releaseAfterGuarantee().accountsPartial({
      distribution, vault, lock: lockOf(distribution), recipientLocked: seller.publicKey, caller: caller.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
    }).signers([caller]).rpc();
    const fiche = () => program.account.paymentDistribution.fetch(distribution);
    return { buyer, seller, stranger, distribution, vault, vote, release, fiche };
  }

  it("garantie échue sans vote : n'importe qui verse les fonds au vendeur ; pas avant l'échéance", async () => {
    const t = await solDeal();
    await start(t.distribution, SHORT);
    const lock = await program.account.guaranteeLock.fetch(lockOf(t.distribution));
    expect(lock.endsAt.toNumber() - lock.startedAt.toNumber()).to.equal(SHORT);
    expect(lock.suspended).to.equal(false);
    try { await t.release(); expect.fail("versement avant l'échéance accepté"); } catch (e) { expectRejection(e, "GuaranteeNotOver"); }

    await waitChainSeconds(SHORT + 1);
    const [sellerBefore, platformBefore, vaultBefore] = await Promise.all([lamports(t.seller.publicKey), lamports(PLATFORM), lamports(t.vault)]);
    await t.release();
    // La part séquestrée exacte au vendeur, la rente du coffre au payeur du dépôt (audit SC-02).
    expect((await lamports(t.seller.publicKey)) - sellerBefore).to.equal(LOCKED);
    // Le payeur paie aussi les frais du versement (fournisseur des tests).
    expect((await lamports(PLATFORM)) - platformBefore).to.be.within(vaultBefore - LOCKED - 10_000, vaultBefore - LOCKED);
    expect(await lamports(t.vault)).to.equal(0);
    expect((await t.fiche()).released).to.equal(true);
    try { await t.release(); expect.fail("second versement accepté"); } catch (e) { expectRejection(e, "AlreadyReleased"); }
  });

  it("un seul vote « libérer » à l'échéance : versement au vendeur", async () => {
    const t = await solDeal();
    await start(t.distribution, SHORT);
    await t.vote(t.buyer, RELEASE);
    await waitChainSeconds(SHORT + 1);
    await t.release();
    expect((await t.fiche()).released).to.equal(true);
  });

  it("vote « rembourser » en attente : aucun versement automatique, les votes restent possibles", async () => {
    const t = await solDeal();
    await start(t.distribution, SHORT);
    await t.vote(null, REFUND);
    await waitChainSeconds(SHORT + 1);
    try { await t.release(); expect.fail("versement malgré un vote rembourser"); } catch (e) { expectRejection(e, "RefundVotePending"); }
    const buyerBefore = await lamports(t.buyer.publicKey);
    await t.vote(t.buyer, REFUND);
    expect((await lamports(t.buyer.publicKey)) - buyerBefore).to.be.at.least(LOCKED - 10_000);
    expect((await t.fiche()).cancelled).to.equal(true);
  });

  it("litige : la plateforme suspend la garantie, plus de versement automatique", async () => {
    const t = await solDeal();
    await start(t.distribution, SHORT);
    try { await suspend(t.distribution, t.stranger); expect.fail("suspension par un tiers acceptée"); } catch (e) { expectRejection(e, "Unauthorized"); }
    await suspend(t.distribution);
    await waitChainSeconds(SHORT + 1);
    try { await t.release(); expect.fail("versement malgré la suspension"); } catch (e) { expectRejection(e, "GuaranteeSuspended"); }
    expect((await program.account.guaranteeLock.fetch(lockOf(t.distribution))).suspended).to.equal(true);
  });

  it("litige : l'acheteur suspend lui-même la garantie si la plateforme ne le fait pas ; pas le vendeur", async () => {
    const t = await solDeal();
    await start(t.distribution, SHORT);
    try { await suspend(t.distribution, t.seller); expect.fail("suspension par le vendeur acceptée"); } catch (e) { expectRejection(e, "Unauthorized"); }
    await suspend(t.distribution, t.buyer);
    await waitChainSeconds(SHORT + 1);
    try { await t.release(); expect.fail("versement malgré la suspension"); } catch (e) { expectRejection(e, "GuaranteeSuspended"); }
  });

  it("seule la plateforme ouvre la garantie, une seule fois, pour une durée valide", async () => {
    const t = await solDeal(3_600);
    try { await start(t.distribution, SHORT, t.seller); expect.fail("ouverture par le vendeur acceptée"); } catch (e) { expectRejection(e, "Unauthorized"); }
    try { await start(t.distribution, 366 * 24 * 3_600); expect.fail("durée de plus d'un an acceptée"); } catch (e) { expectRejection(e, "InvalidGuaranteeDuration"); }
    await start(t.distribution, 3_600);
    try { await start(t.distribution, SHORT); expect.fail("seconde ouverture (fin raccourcie) acceptée"); } catch (e) { expectRejection(e, "already in use"); }
    // Garantie d'une heure : toujours en cours.
    try { await t.release(); expect.fail("versement avant l'échéance accepté"); } catch (e) { expectRejection(e, "GuaranteeNotOver"); }
  });

  it("durée signée par l'acheteur au dépôt : la clé de la plateforme ne peut pas l'écourter (audit P-E04)", async () => {
    const t = await solDeal(3_600);
    await start(t.distribution, SHORT);
    const lock = await program.account.guaranteeLock.fetch(lockOf(t.distribution));
    expect(lock.endsAt.toNumber() - lock.startedAt.toNumber()).to.equal(3_600);
    try { await t.release(); expect.fail("versement avant la durée signée accepté"); } catch (e) { expectRejection(e, "GuaranteeNotOver"); }
  });

  it("termes : fixés par l'acheteur seul, une fois ; sans termes ou à 0, pas de versement automatique", async () => {
    const noTerms = await solDeal(null);
    try { await recordTerms(noTerms.distribution, noTerms.seller, SHORT); expect.fail("termes fixés par le vendeur acceptés"); } catch (e) { expectRejection(e, "Unauthorized"); }
    try { await start(noTerms.distribution, SHORT); expect.fail("garantie ouverte sans termes"); } catch (e) { expectRejection(e, "AccountNotInitialized"); }
    try { await recordTerms(noTerms.distribution, noTerms.buyer, 366 * 24 * 3_600); expect.fail("durée de plus d'un an acceptée"); } catch (e) { expectRejection(e, "InvalidGuaranteeDuration"); }
    await recordTerms(noTerms.distribution, noTerms.buyer, 0);
    try { await recordTerms(noTerms.distribution, noTerms.buyer, SHORT); expect.fail("seconds termes acceptés"); } catch (e) { expectRejection(e, "already in use"); }
    try { await start(noTerms.distribution, SHORT); expect.fail("garantie ouverte sans versement automatique prévu"); } catch (e) { expectRejection(e, "NoAutomaticRelease"); }
  });

  it("dépôt USDC : à l'échéance, les jetons partent au vendeur et le coffre est fermé", async () => {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    const stranger = anchor.web3.Keypair.generate();
    await airdrop(buyer.publicKey);
    await airdrop(stranger.publicKey, 1);
    const buyerToken = await createAssociatedTokenAccount(provider.connection, buyer, USDC, buyer.publicKey);
    await mintTo(provider.connection, platformKeypair, USDC, buyerToken, platformKeypair, AMOUNT);
    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const [distribution] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("token_distribution"), buyer.publicKey.toBuffer(), paymentId.toArrayLike(Buffer, "le", 8)], program.programId);
    const [vault] = anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("token_vault"), distribution.toBuffer()], program.programId);
    const ata = (owner: anchor.web3.PublicKey) => getAssociatedTokenAddressSync(USDC, owner);
    const programs = { tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: anchor.web3.SystemProgram.programId };
    await program.methods.initializeTokenDistributionExact(paymentId, new anchor.BN(AMOUNT), new anchor.BN(AMOUNT * 600 / 10_000), new anchor.BN(AMOUNT * 150 / 10_000))
      .accountsPartial({
        ...programs, distribution, mint: USDC, vault, payer: PLATFORM, funder: buyer.publicKey, funderToken: buyerToken,
        recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee15Token: ata(sponsor.publicKey),
        platform: TREASURY, platformToken: ata(TREASURY),
      })
      .signers([buyer]).rpc();
    await recordTerms(distribution, buyer, SHORT);

    await start(distribution, SHORT);
    await waitChainSeconds(SHORT + 1);
    await program.methods.releaseTokenAfterGuarantee().accountsPartial({
      ...programs, distribution, mint: USDC, vault, lock: lockOf(distribution),
      recipientLocked: seller.publicKey, recipientLockedToken: ata(seller.publicKey), payer: PLATFORM, caller: stranger.publicKey,
    }).signers([stranger]).rpc();
    expect(Number((await getAccount(provider.connection, ata(seller.publicKey))).amount)).to.equal(LOCKED);
    expect(await provider.connection.getAccountInfo(vault)).to.equal(null);
    expect((await program.account.tokenDistribution.fetch(distribution)).released).to.equal(true);
  });
});
