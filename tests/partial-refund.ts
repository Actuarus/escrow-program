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

// Remboursement partiel : le vendeur propose (et peut modifier) une part à rendre ; l'acheteur accepte le montant exact
// qu'il a lu : sa part lui revient, le reste au vendeur. Personne d'autre ne propose ni n'accepte ; l'arbitre ne
// peut pas imposer de partage ; une proposition en attente bloque le versement automatique de fin de garantie.
describe("remboursement partiel proposé par le vendeur, accepté par l'acheteur", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.anchorWorkspace as Program<AnchorWorkspace>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const platformKeypair = (provider.wallet as anchor.Wallet).payer;

  const PLATFORM = new anchor.web3.PublicKey("HrGT7nC7wTEC7YaDetkUyiscQcRtwGRLn6wb1cNrr7hP");
  const USDC = new anchor.web3.PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
  const RELEASE = 1;
  const REFUND = 2;
  const AMOUNT = 1_000_000_000; // 1 SOL (ou 1 000 USDC en unités de 6 décimales)
  const LOCKED = 925_000_000;
  const SHORT = 2;
  const SEEDS = [9_250, 150, 600].map(v => new anchor.BN(v).toArrayLike(Buffer, "le", 8));
  const system = { systemProgram: anchor.web3.SystemProgram.programId };

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
  const pda = (...parts: Buffer[]) => anchor.web3.PublicKey.findProgramAddressSync(parts, program.programId)[0];
  const lockOf = (distribution: anchor.web3.PublicKey) => pda(Buffer.from("guarantee"), distribution.toBuffer());
  const proposalOf = (distribution: anchor.web3.PublicKey) => pda(Buffer.from("partial_refund"), distribution.toBuffer());

  // Proposition du vendeur (ou d'un autre signataire, pour les refus), payée par la plateforme.
  const propose = (distribution: anchor.web3.PublicKey, seller: anchor.web3.Keypair, amount: number) =>
    program.methods.proposePartialRefund(new anchor.BN(amount)).accountsPartial({
      proposal: proposalOf(distribution), distribution, seller: seller.publicKey, platform: PLATFORM, ...system,
    }).signers([seller]).rpc();
  const decline = (distribution: anchor.web3.PublicKey, buyer: anchor.web3.Keypair) =>
    program.methods.declinePartialRefund().accountsPartial({
      proposal: proposalOf(distribution), distribution, buyer: buyer.publicKey, platform: PLATFORM,
    }).signers([buyer]).rpc();
  const termsOf = (distribution: anchor.web3.PublicKey) => pda(Buffer.from("terms"), distribution.toBuffer());
  const start = (distribution: anchor.web3.PublicKey, seconds: number) => program.methods.startGuarantee(new anchor.BN(seconds))
    .accountsPartial({ lock: lockOf(distribution), distribution, terms: termsOf(distribution), platform: PLATFORM, ...system }).rpc();
  // Termes signés par l'acheteur au dépôt : durée de garantie (versement automatique prévu).
  const recordTerms = (distribution: anchor.web3.PublicKey, buyer: anchor.web3.Keypair, seconds: number) =>
    program.methods.recordTerms(new anchor.BN(seconds)).accountsPartial({ terms: termsOf(distribution), distribution, funder: buyer.publicKey, platform: PLATFORM, ...system })
      .signers([buyer]).rpc();

  async function solDeal() {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    const stranger = anchor.web3.Keypair.generate();
    await airdrop(buyer.publicKey, 3);
    await airdrop(seller.publicKey, 1);
    await airdrop(sponsor.publicKey, 1);
    await airdrop(stranger.publicKey, 1);
    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const idBytes = paymentId.toArrayLike(Buffer, "le", 8);
    const distribution = pda(Buffer.from("distribution"), buyer.publicKey.toBuffer(), idBytes);
    const vault = pda(Buffer.from("vault"), buyer.publicKey.toBuffer(), idBytes, ...SEEDS);
    await program.methods.initializeDistributionExact(paymentId, new anchor.BN(AMOUNT), new anchor.BN(AMOUNT * 600 / 10_000), new anchor.BN(AMOUNT * 150 / 10_000))
      .accountsPartial({
        distribution, vault, payer: PLATFORM, funder: buyer.publicKey,
        recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee6: TREASURY, ...system,
      })
      .signers([buyer]).rpc();
    await recordTerms(distribution, buyer, SHORT);
    const accept = (signer: anchor.web3.Keypair, expected: number) => program.methods.acceptPartialRefund(new anchor.BN(expected))
      .accountsPartial({
        distribution, vault, proposal: proposalOf(distribution), funder: signer.publicKey, recipientLocked: seller.publicKey, payer: PLATFORM, ...system,
      }).signers([signer]).rpc();
    const vote = (voter: anchor.web3.Keypair | null, decision: number) => {
      const call = program.methods.voteDistribution(decision).accountsPartial({
        distribution, vault, voter: (voter ?? TREASURY_KEYPAIR).publicKey, funder: buyer.publicKey, recipientLocked: seller.publicKey, ...system,
      });
      return call.signers([voter ?? TREASURY_KEYPAIR]).rpc();
    };
    const release = () => program.methods.releaseAfterGuarantee().accountsPartial({
      distribution, vault, lock: lockOf(distribution), recipientLocked: seller.publicKey, caller: stranger.publicKey, ...system,
    }).signers([stranger]).rpc();
    const fiche = () => program.account.paymentDistribution.fetch(distribution);
    return { buyer, seller, stranger, distribution, vault, accept, vote, release, fiche };
  }

  before(async () => { await airdrop(PLATFORM, 10); });

  it("SOL : proposition modifiable, acceptation au montant exact → part à l'acheteur, reste au vendeur", async () => {
    const t = await solDeal();
    await propose(t.distribution, t.seller, 300_000_000);
    expect((await program.account.partialRefund.fetch(proposalOf(t.distribution))).refundAmount.toNumber()).to.equal(300_000_000);
    // Modification par le vendeur tant que l'acheteur n'a pas accepté.
    await propose(t.distribution, t.seller, 250_000_000);
    expect((await program.account.partialRefund.fetch(proposalOf(t.distribution))).refundAmount.toNumber()).to.equal(250_000_000);
    // L'acheteur accepte ce qu'il a lu : un montant changé entre-temps est refusé.
    try { await t.accept(t.buyer, 300_000_000); expect.fail("acceptation d'un montant périmé"); } catch (e) { expectRejection(e, "RefundAmountMismatch"); }

    const [buyerBefore, sellerBefore, platformBefore] = await Promise.all([lamports(t.buyer.publicKey), lamports(t.seller.publicKey), lamports(PLATFORM)]);
    const vaultBefore = await lamports(t.vault);
    await t.accept(t.buyer, 250_000_000);
    const [buyerAfter, sellerAfter, platformAfter] = await Promise.all([lamports(t.buyer.publicKey), lamports(t.seller.publicKey), lamports(PLATFORM)]);
    // L'acheteur paie les frais de sa transaction (5 000 lamports) ; le vendeur reçoit le reste de la part séquestrée,
    // la plateforme la rente du coffre et celle de la proposition (audit SC-02).
    expect(buyerAfter - buyerBefore).to.be.within(250_000_000 - 10_000, 250_000_000);
    expect(sellerAfter - sellerBefore).to.equal(LOCKED - 250_000_000);
    expect(platformAfter - platformBefore).to.be.greaterThan(vaultBefore - LOCKED, "rentes du coffre et de la proposition rendues à la plateforme");
    expect(await lamports(t.vault)).to.equal(0);
    const fiche = await t.fiche();
    expect([fiche.released, fiche.cancelled]).to.deep.equal([true, true]);
    expect(await provider.connection.getAccountInfo(proposalOf(t.distribution))).to.equal(null);
    // Dépôt soldé : plus de vote, plus de proposition.
    try { await t.vote(t.buyer, REFUND); expect.fail("vote après le partage"); } catch (e) { expectRejection(e, "AlreadyReleased"); }
    try { await propose(t.distribution, t.seller, 100); expect.fail("proposition après le partage"); } catch (e) { expectRejection(e, "AlreadyReleased"); }
  });

  it("seul le vendeur propose, seul l'acheteur accepte ou refuse ; montant strictement partiel", async () => {
    const t = await solDeal();
    for (const signer of [t.buyer, t.stranger]) {
      try { await propose(t.distribution, signer, 100_000_000); expect.fail("proposition par un autre que le vendeur"); } catch (e) { expectRejection(e, "Unauthorized"); }
    }
    try { await propose(t.distribution, t.seller, 0); expect.fail("proposition nulle"); } catch (e) { expectRejection(e, "InvalidRefundAmount"); }
    try { await propose(t.distribution, t.seller, LOCKED); expect.fail("proposition totale"); } catch (e) { expectRejection(e, "InvalidRefundAmount"); }
    await propose(t.distribution, t.seller, 100_000_000);
    for (const signer of [t.seller, t.stranger]) {
      try { await t.accept(signer, 100_000_000); expect.fail("acceptation par un autre que l'acheteur"); } catch (e) { expectRejection(e, "Unauthorized"); }
      try { await decline(t.distribution, signer); expect.fail("refus par un autre que l'acheteur"); } catch (e) { expectRejection(e, "Unauthorized"); }
    }
    // Refus de l'acheteur : la proposition disparaît, le séquestre reste ouvert ; le vendeur peut en refaire une.
    await decline(t.distribution, t.buyer);
    expect(await provider.connection.getAccountInfo(proposalOf(t.distribution))).to.equal(null);
    const fiche = await t.fiche();
    expect([fiche.released, fiche.cancelled]).to.deep.equal([false, false]);
    await propose(t.distribution, t.seller, 50_000_000);
    expect((await program.account.partialRefund.fetch(proposalOf(t.distribution))).refundAmount.toNumber()).to.equal(50_000_000);
  });

  it("proposition en attente : pas de versement automatique ; refusée, le versement redevient possible", async () => {
    const t = await solDeal();
    await start(t.distribution, SHORT);
    await propose(t.distribution, t.seller, 100_000_000);
    await waitChainSeconds(SHORT + 1);
    try { await t.release(); expect.fail("versement malgré une proposition en attente"); } catch (e) { expectRejection(e, "PartialRefundPending"); }
    await decline(t.distribution, t.buyer);
    await t.release();
    expect((await t.fiche()).released).to.equal(true);
  });

  it("un virement de SOL à l'adresse de la proposition ne bloque pas le versement automatique", async () => {
    const t = await solDeal();
    await start(t.distribution, SHORT);
    const tx = new anchor.web3.Transaction().add(anchor.web3.SystemProgram.transfer({ fromPubkey: t.stranger.publicKey, toPubkey: proposalOf(t.distribution), lamports: 1_000_000 }));
    await provider.sendAndConfirm(tx, [t.stranger]);
    await waitChainSeconds(SHORT + 1);
    await t.release();
    expect((await t.fiche()).released).to.equal(true);
  });

  it("dépôt soldé par les votes : la proposition devenue sans objet est supprimée, pas avant", async () => {
    const t = await solDeal();
    await propose(t.distribution, t.seller, 100_000_000);
    const close = () => program.methods.closePartialRefund().accountsPartial({
      proposal: proposalOf(t.distribution), distribution: t.distribution, platform: PLATFORM, caller: t.stranger.publicKey,
    }).signers([t.stranger]).rpc();
    try { await close(); expect.fail("suppression d'une proposition d'un dépôt ouvert"); } catch (e) { expectRejection(e, "DistributionStillOpen"); }
    // L'arbitre ne peut pas imposer le partage : son vote reste « libérer » ou « rembourser » (tout d'un côté).
    await t.vote(null, REFUND);
    await t.vote(t.buyer, REFUND);
    try { await t.accept(t.buyer, 100_000_000); expect.fail("acceptation après remboursement total"); } catch (e) { expectRejection(e, "AlreadyCancelled"); }
    await close();
    expect(await provider.connection.getAccountInfo(proposalOf(t.distribution))).to.equal(null);
  });

  it("dépôt USDC : partage des jetons, coffre fermé", async () => {
    const buyer = anchor.web3.Keypair.generate();
    const seller = anchor.web3.Keypair.generate();
    const sponsor = anchor.web3.Keypair.generate();
    await airdrop(buyer.publicKey);
    await airdrop(seller.publicKey, 1);
    const buyerToken = await createAssociatedTokenAccount(provider.connection, buyer, USDC, buyer.publicKey);
    await mintTo(provider.connection, platformKeypair, USDC, buyerToken, platformKeypair, AMOUNT);
    const paymentId = new anchor.BN(Date.now() + Math.floor(Math.random() * 1_000_000));
    const distribution = pda(Buffer.from("token_distribution"), buyer.publicKey.toBuffer(), paymentId.toArrayLike(Buffer, "le", 8));
    const vault = pda(Buffer.from("token_vault"), distribution.toBuffer());
    const ata = (owner: anchor.web3.PublicKey) => getAssociatedTokenAddressSync(USDC, owner);
    const programs = { tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, ...system };
    await program.methods.initializeTokenDistributionExact(paymentId, new anchor.BN(AMOUNT), new anchor.BN(AMOUNT * 600 / 10_000), new anchor.BN(AMOUNT * 150 / 10_000))
      .accountsPartial({
        ...programs, distribution, mint: USDC, vault, payer: PLATFORM, funder: buyer.publicKey, funderToken: buyerToken,
        recipientLocked: seller.publicKey, recipientFee15: sponsor.publicKey, recipientFee15Token: ata(sponsor.publicKey),
        platform: TREASURY, platformToken: ata(TREASURY),
      })
      .signers([buyer]).rpc();

    await propose(distribution, seller, 400_000_000);
    const accept = (expected: number) => program.methods.acceptTokenPartialRefund(new anchor.BN(expected)).accountsPartial({
      ...programs, distribution, mint: USDC, vault, proposal: proposalOf(distribution), funder: buyer.publicKey, funderToken: ata(buyer.publicKey),
      recipientLocked: seller.publicKey, recipientLockedToken: ata(seller.publicKey), payer: PLATFORM,
    }).signers([buyer]).rpc();
    try { await accept(1); expect.fail("montant différent accepté"); } catch (e) { expectRejection(e, "RefundAmountMismatch"); }
    const buyerBefore = Number((await getAccount(provider.connection, buyerToken)).amount);
    await accept(400_000_000);
    expect(Number((await getAccount(provider.connection, buyerToken)).amount) - buyerBefore).to.equal(400_000_000);
    expect(Number((await getAccount(provider.connection, ata(seller.publicKey))).amount)).to.equal(LOCKED - 400_000_000);
    expect(await provider.connection.getAccountInfo(vault)).to.equal(null);
    const fiche = await program.account.tokenDistribution.fetch(distribution);
    expect([fiche.released, fiche.cancelled]).to.deep.equal([true, true]);
  });

  it("votes concordants « libérer » malgré une proposition : versement total au vendeur (la proposition n'engage que l'acheteur qui l'accepte)", async () => {
    const t = await solDeal();
    await propose(t.distribution, t.seller, 100_000_000);
    await t.vote(t.buyer, RELEASE);
    await t.vote(t.seller, RELEASE);
    expect((await t.fiche()).released).to.equal(true);
  });
});
